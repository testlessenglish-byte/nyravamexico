import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assessmentInput, carePlanInput, consentInput, referralInput,
  socialCaseInput, socialFamilyInput, socialPersonInput, socialSearchInput,
} from "@/lib/social/types";
import { z } from "zod";

const uuid=z.string().uuid();
type AuthContext={supabase:any;userId:string};
function ctx(context:unknown):AuthContext {
  const c=context as AuthContext;
  if(!c?.supabase||!c.userId) throw new Error("Sesión requerida / Signed-in session required");
  return c;
}
function fail(error:{message?:string}|null){if(error) throw new Error(error.message||"Social-care operation failed");}

export const getSocialWorkspace=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .handler(async({context})=>{
    const {supabase,userId}=ctx(context);
    // Claim every still-pending invitation that belongs to this authenticated
    // email before RLS resolves the user's organization list. This also covers
    // users who signed in directly instead of preserving the invitation token.
    const {error:autoJoinError}=await supabase.rpc("accept_matching_social_organization_invitations");
    if(autoJoinError){
      console.error("[getSocialWorkspace] automatic invitation acceptance failed",autoJoinError);
    }
    const {data:organizations,error:orgError}=await supabase.from("organizations").select("id,name").order("name");
    fail(orgError);
    const orgIds=(organizations??[]).map((o:any)=>o.id);
    const empty={organizations:[],organizationAccounts:[],programs:[],offices:[],cases:[],people:[],families:[],alerts:[],institutions:[],templates:[],roleAssignments:[],recentActivity:[],stats:{active:0,critical:0,overdue:0,unverifiedReferrals:0},userId};
    if(!orgIds.length)return empty;
    const [programs,offices,cases,people,families,alerts,referrals,tasks,institutions,templates,roleAssignments,recentActivity]=await Promise.all([
      supabase.from("social_programs").select("id,org_id,name_es,name_en,case_prefix,active,settings").in("org_id",orgIds).eq("active",true).order("name_es"),
      supabase.from("social_offices").select("id,org_id,name,address,active").in("org_id",orgIds).eq("active",true).order("name"),
      supabase.from("social_cases").select("id,org_id,program_id,case_number,case_type,status,priority,risk_level,last_activity_at,next_required_action,person_id,family_id,assigned_case_manager,supervising_manager,service_areas,confidentiality_level,consent_status").in("org_id",orgIds).is("deleted_at",null).order("last_activity_at",{ascending:false}).limit(250),
      supabase.from("social_people").select("id,org_id,person_number,legal_name,preferred_name,telephone,email,consent_status,record_status").in("org_id",orgIds).is("deleted_at",null).order("updated_at",{ascending:false}).limit(250),
      supabase.from("social_families").select("id,org_id,family_number,family_name,primary_contact_person_id,assigned_case_manager,current_location").in("org_id",orgIds).is("deleted_at",null).order("updated_at",{ascending:false}).limit(250),
      supabase.from("social_alerts").select("id,org_id,social_case_id,alert_type,severity,title_es,title_en,due_at,assigned_to,acknowledged_at").in("org_id",orgIds).is("resolved_at",null).order("due_at",{ascending:true}).limit(250),
      supabase.from("social_referrals").select("id,status").in("org_id",orgIds).neq("status","completed"),
      supabase.from("social_tasks").select("id,status,due_at").in("org_id",orgIds).neq("status","done"),
      supabase.from("social_institutions").select("id,org_id,name,institution_type,services,active").or(`org_id.is.null,org_id.in.(${orgIds.join(",")})`).eq("active",true).order("name"),
      supabase.from("social_assessment_templates").select("id,org_id,code,version,name_es,name_en,schema").or(`org_id.is.null,org_id.in.(${orgIds.join(",")})`).eq("active",true).order("name_es"),
      supabase.from("social_role_assignments").select("id,org_id,user_id,role,scope_type,scope_id,active,ends_at").in("org_id",orgIds).eq("active",true),
      supabase.from("social_activity_events").select("id,org_id,social_case_id,actor_id,event_type,entity_type,occurred_at").in("org_id",orgIds).order("occurred_at",{ascending:false}).limit(100),
    ]);
    [programs,offices,cases,people,families,alerts,referrals,tasks,institutions,templates,roleAssignments,recentActivity].forEach((r:any)=>fail(r.error));
    const organizationAccounts=await Promise.all(orgIds.map(async(orgId:string)=>{
      const {data,error}=await supabase.rpc("get_social_organization_account",{p_org:orgId});
      fail(error);return {orgId,...(data??{})};
    }));
    const now=Date.now();const caseRows=cases.data??[];
    return {
      organizations:organizations??[],organizationAccounts,programs:programs.data??[],offices:offices.data??[],
      cases:caseRows,people:people.data??[],families:families.data??[],alerts:alerts.data??[],
      institutions:institutions.data??[],templates:templates.data??[],
      roleAssignments:roleAssignments.data??[],recentActivity:recentActivity.data??[],userId,
      stats:{
        active:caseRows.filter((c:any)=>!["closed","archived","transferred"].includes(c.status)).length,
        critical:caseRows.filter((c:any)=>c.risk_level==="critical").length,
        overdue:(tasks.data??[]).filter((t:any)=>t.due_at&&new Date(t.due_at).getTime()<now).length,
        unverifiedReferrals:(referrals.data??[]).filter((r:any)=>["sent","received","appointment_scheduled","in_progress"].includes(r.status)).length,
      },
    };
  });

export const searchSocialRecords=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>socialSearchInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:rows,error}=await supabase.rpc("search_social_case_management",{
      p_org:data.orgId,p_query:data.query,p_status:data.status??null,
      p_risk:data.riskLevel??null,p_assignee:null,p_limit:data.limit,
    });
    fail(error); return rows??[];
  });

export const findPossibleSocialPeople=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,name:z.string().trim().min(2).max(240),dateOfBirth:z.string().date().optional(),phone:z.string().max(50).optional(),email:z.string().email().optional(),limit:z.number().int().min(1).max(20).default(10)}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:rows,error}=await supabase.rpc("find_possible_social_people",{
      p_org:data.orgId,p_name:data.name,p_date_of_birth:data.dateOfBirth??null,
      p_phone:data.phone??null,p_email:data.email??null,p_limit:data.limit,
    });
    fail(error);return rows??[];
  });

export const createSocialPerson=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>socialPersonInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("create_social_person",{
      p_org:data.orgId,p_legal_name:data.legalName,p_preferred_name:data.preferredName??null,
      p_aliases:data.aliases,p_date_of_birth:data.dateOfBirth??null,
      p_approximate_age:data.approximateAge??null,p_nationality:data.nationality??null,
      p_languages:data.languages,p_telephone:data.telephone??null,p_email:data.email||null,
      p_current_location:data.currentLocation,p_immigration_identifiers:data.immigrationIdentifiers,
      p_is_minor:data.isMinor??null,p_unaccompanied_minor:data.unaccompaniedMinor,
      p_separated_minor:data.separatedMinor,
    });
    fail(error);return row;
  });

export const createSocialFamily=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>socialFamilyInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:family,error}=await supabase.rpc("create_social_family",{
      p_org:data.orgId,p_name:data.familyName,p_primary:data.primaryContactPersonId??null,
      p_location:data.currentLocation,p_members:data.memberIds,
    });
    fail(error);return family;
  });

export const createAndAssignCareCase=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>socialCaseInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("create_and_assign_care_case",{
      p_org:data.orgId,p_program:data.programId,p_person:data.personId??null,
      p_client_name:data.newClientName??null,p_family:data.familyId??null,p_case_type:data.caseType,
      p_priority:data.priority,p_assigned_user:data.assignedUserId??null,
    });
    fail(error);return row;
  });

export const deleteSocialCase=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    caseId:uuid,
    reason:z.string().trim().min(5).max(1000),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:result,error}=await supabase.rpc(
      "delete_social_case_by_assigning_manager",
      {p_case:data.caseId,p_reason:data.reason},
    );
    fail(error);return result;
  });

export const getSocialCase=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const [caseRow,intakes,assessments,plans,interventions,referrals,tasks,appointments,alerts,documents,requirements,consents,transfers,closures,activity]=await Promise.all([
      supabase.rpc("get_social_case_core",{p_case:data.caseId}),
      supabase.from("social_intakes").select("id,intake_number,source,status,disposition,summary,presenting_needs,assigned_to,created_at,completed_at").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_assessments").select("*,social_assessment_versions(*)").eq("social_case_id",data.caseId).order("assessment_date",{ascending:false}),
      supabase.from("social_care_plans").select("*,social_care_plan_versions(*,social_care_plan_goals(*))").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_interventions").select("*").eq("social_case_id",data.caseId).order("occurred_at",{ascending:false}),
      supabase.from("social_referrals").select("*,social_referral_updates(*)").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_tasks").select("*").eq("social_case_id",data.caseId).order("due_at",{ascending:true}),
      supabase.from("social_appointments").select("*").eq("social_case_id",data.caseId).order("scheduled_at",{ascending:true}),
      supabase.from("social_alerts").select("id,alert_type,severity,title_es,title_en,due_at,acknowledged_at,resolved_at,created_at").eq("social_case_id",data.caseId).is("resolved_at",null).order("created_at",{ascending:false}),
      supabase.from("social_documents").select("id,title,document_type,record_type,sensitivity,current_version,checksum,mime_type,size_bytes,extraction_authorized,created_at").eq("social_case_id",data.caseId).is("deleted_at",null),
      supabase.from("social_case_document_requirements").select("id,document_type,status,due_at,notes").eq("social_case_id",data.caseId).order("created_at",{ascending:true}),
      supabase.from("social_consents").select("*,social_consent_versions(*)").order("created_at",{ascending:false}),
      supabase.from("social_case_transfers").select("*,social_case_transfer_items(*)").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_case_closures").select("*").eq("social_case_id",data.caseId).order("closure_version",{ascending:false}),
      supabase.from("social_activity_events").select("id,actor_id,event_type,entity_type,entity_id,metadata,occurred_at").eq("social_case_id",data.caseId).order("occurred_at",{ascending:false}).limit(100),
    ]);
    fail(caseRow.error);
    const c=caseRow.data;
    if(!c)throw new Error("The selected Comprehensive Care case is unavailable");
    const warnings:string[]=[];
    const optionalRows=(label:string,result:any)=>{
      if(result.error){
        warnings.push(`${label}: ${result.error.message??"unavailable"}`);
        return [];
      }
      return result.data??[];
    };
    const intakeRows=optionalRows("intakes",intakes);
    const assessmentRows=optionalRows("assessments",assessments);
    const planRows=optionalRows("care plans",plans);
    const interventionRows=optionalRows("interventions",interventions);
    const referralRows=optionalRows("referrals",referrals);
    const taskRows=optionalRows("tasks",tasks);
    const appointmentRows=optionalRows("appointments",appointments);
    const alertRows=optionalRows("alerts",alerts);
    const documentRows=optionalRows("documents",documents);
    const requirementRows=optionalRows("document requirements",requirements);
    const consentRows=optionalRows("consents",consents)
      .filter((x:any)=>x.person_id===c.person_id||x.family_id===c.family_id);
    const transferRows=optionalRows("transfers",transfers);
    const closureRows=optionalRows("closures",closures);
    const activityRows=optionalRows("activity",activity);
    return {
      case:c,intakes:intakeRows,assessments:assessmentRows,plans:planRows,interventions:interventionRows,
      referrals:referralRows,tasks:taskRows,appointments:appointmentRows,
      alerts:alertRows,documents:documentRows,requirements:requirementRows,consents:consentRows,transfers:transferRows,
      closures:closureRows,activity:activityRows,warnings,
    };
  });

export const recordSocialAssessment=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>assessmentInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:existing,error:existingError}=await supabase.from("social_assessments")
      .select("id,current_version").eq("social_case_id",data.socialCaseId)
      .order("created_at",{ascending:false}).limit(1).maybeSingle();
    fail(existingError);
    if(existing){
      const {data:version,error}=await supabase.rpc("record_social_assessment",{
        p_assessment:existing.id,p_risk_level:data.riskLevel,p_evidence:data.evidenceObservations??null,
        p_reason:data.reason,p_protective_factors:data.protectiveFactors??null,
        p_immediate_actions:data.immediateActions??null,p_required_follow_up:data.requiredFollowUp??null,
        p_answers:data.answers,p_next_review:data.nextReviewDate??null,p_override:data.professionalOverride,
        p_override_explanation:data.overrideExplanation??null,
      });fail(error);return {assessmentId:existing.id,version};
    }
    const {data:assessmentId,error}=await supabase.rpc("create_social_assessment_initial",{
      p_case:data.socialCaseId,p_template:data.templateId??null,p_risk:data.riskLevel,
      p_evidence:data.evidenceObservations??null,p_reason:data.reason,
      p_protective:data.protectiveFactors??null,p_actions:data.immediateActions??null,
      p_follow_up:data.requiredFollowUp??null,p_answers:data.answers,
      p_review:data.nextReviewDate??null,p_override:data.professionalOverride,
      p_override_explanation:data.overrideExplanation??null,
    });fail(error);return {assessmentId,version:1};
  });

export const createSocialCarePlan=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>carePlanInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:planId,error}=await supabase.rpc("create_social_care_plan",{
      p_case:data.socialCaseId,p_summary:data.summary,p_status:data.status,p_goals:data.goals,
    });
    fail(error);return {planId,version:1};
  });

export const createSocialConsent=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>consentInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:consentId,error}=await supabase.rpc("create_social_consent",{
      p_org:data.orgId,p_person:data.personId??null,p_family:data.familyId??null,
      p_type:data.consentType,p_language:data.language,p_consented_by:data.consentedByName,
      p_guardian:data.guardianRepresentative??null,p_purposes:data.permittedPurposes,
      p_recipients:data.permittedRecipients,p_information:data.permittedInformation,
      p_restrictions:data.restrictions??null,p_expires:data.expiresAt??null,
      p_confirmation:{method:"recorded_in_app",confirmed_at:new Date().toISOString()},
    });
    fail(error);return {consentId,version:1};
  });

export const createSocialReferral=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>referralInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,person_id,family_id").eq("id",data.socialCaseId).single();fail(caseError);
    const status=data.consentId?"draft":"awaiting_consent";
    const {data:row,error}=await supabase.from("social_referrals").insert({org_id:c.org_id,social_case_id:data.socialCaseId,referral_number:null,person_id:data.personId??c.person_id,family_id:data.familyId??c.family_id,receiving_institution_id:data.institutionId,service_requested:data.serviceRequested,reason:data.reason,urgency:data.urgency,consent_id:data.consentId??null,authorized_information:data.authorizedInformation,status,created_by:userId}).select("id,referral_number,status").single();fail(error);return row;
  });

export const revokeSocialConsent=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({consentId:uuid,reason:z.string().trim().min(3).max(1000)}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {error}=await supabase.from("social_consents").update({status:"revoked",revoked_at:new Date().toISOString()}).eq("id",data.consentId);fail(error);
    return {ok:true,reason:data.reason};
  });


const recordType=z.enum(["general_case_record","social_work_record","legal_privileged_record","psychosocial_restricted_record","medical_restricted_record","child_protection_restricted_record"]);

export const recordSocialIntervention=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    socialCaseId:uuid,occurredAt:z.string().datetime(),serviceType:z.string().trim().min(2).max(120),
    locationMethod:z.string().trim().max(240).optional(),reason:z.string().trim().min(2).max(5000),
    actionsTaken:z.string().trim().min(2).max(10000),outcome:z.string().trim().max(5000).optional(),
    followUpRequired:z.boolean().default(false),recordType:recordType.default("general_case_record"),
    confidentialityLevel:z.enum(["standard","confidential","restricted","highly_restricted"]).default("standard"),
    nextAppointment:z.string().datetime().optional(),carePlanGoalId:uuid.optional(),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,person_id,family_id").eq("id",data.socialCaseId).single();fail(caseError);
    const legalServices=new Set(["legal_assistance","immigration_assistance","institutional_advocacy"]);
    const psychosocialServices=new Set(["psychological_support","medical_referral","child_protection"]);
    const protectedRecord=legalServices.has(data.serviceType)
      ?{recordType:"legal_privileged_record",confidentialityLevel:"highly_restricted"}
      :psychosocialServices.has(data.serviceType)
        ?{recordType:"psychosocial_restricted_record",confidentialityLevel:"restricted"}
        :{recordType:data.recordType,confidentialityLevel:data.confidentialityLevel};
    if(data.carePlanGoalId){
      const goal=await supabase.from("social_care_plan_goals").select("care_plan_version_id").eq("id",data.carePlanGoalId).single();fail(goal.error);
      const version=await supabase.from("social_care_plan_versions").select("care_plan_id").eq("id",goal.data.care_plan_version_id).single();fail(version.error);
      const plan=await supabase.from("social_care_plans").select("social_case_id").eq("id",version.data.care_plan_id).single();fail(plan.error);
      if(plan.data.social_case_id!==data.socialCaseId)throw new Error("The selected care-plan goal does not belong to this case");
    }
    const {data:row,error}=await supabase.from("social_interventions").insert({
      org_id:c.org_id,social_case_id:data.socialCaseId,person_id:c.person_id,family_id:c.family_id,
      occurred_at:data.occurredAt,service_type:data.serviceType,professional_id:userId,
      location_method:data.locationMethod??null,reason:data.reason,actions_taken:data.actionsTaken,
      outcome:data.outcome??null,follow_up_required:data.followUpRequired,record_type:protectedRecord.recordType,
      confidentiality_level:protectedRecord.confidentialityLevel,next_appointment:data.nextAppointment??null,
      care_plan_goal_id:data.carePlanGoalId??null,
    }).select("id").single();fail(error);return row;
  });

export const upsertSocialTask=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    id:uuid.optional(),socialCaseId:uuid,title:z.string().trim().min(2).max(300),
    description:z.string().trim().max(4000).optional(),assigneeId:uuid.optional(),
    priority:z.enum(["low","normal","high","urgent"]).default("normal"),
    status:z.enum(["todo","in_progress","blocked","done","cancelled"]).default("todo"),
    dueAt:z.string().datetime().optional(),reminderAt:z.string().datetime().optional(),
    recurrence:z.record(z.string(),z.unknown()).optional(),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id").eq("id",data.socialCaseId).single();fail(caseError);
    const row={org_id:c.org_id,social_case_id:data.socialCaseId,title:data.title,description:data.description??null,assignee_id:data.assigneeId??userId,priority:data.priority,status:data.status,due_at:data.dueAt??null,reminder_at:data.reminderAt??null,recurrence:data.recurrence??null,completed_at:data.status==="done"?new Date().toISOString():null,created_by:userId};
    const q=data.id?supabase.from("social_tasks").update(row).eq("id",data.id):supabase.from("social_tasks").insert(row);
    const {data:saved,error}=await q.select("id,status,due_at").single();fail(error);return saved;
  });

export const closeSocialCase=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    caseId:uuid,reason:z.enum(["services_completed","client_withdrew","unable_to_contact","transferred","ineligible","relocated","duplicate_case","other"]),
    finalRisk:z.enum(["unknown","low","moderate","high","critical"]),
    summary:z.record(z.string(),z.unknown()).default({}),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);const {data:id,error}=await supabase.rpc("close_social_case",{p_case:data.caseId,p_reason:data.reason,p_final_risk:data.finalRisk,p_summary:data.summary});fail(error);return {closureId:id};
  });

export const reopenSocialCase=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid,reason:z.string().trim().min(3).max(2000)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("reopen_social_case",{p_case:data.caseId,p_reason:data.reason});fail(error);return {ok:true};});

export const createSocialTransfer=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    socialCaseId:uuid,transferType:z.enum(["case_manager","office","service_team","external_organization","social_to_legal","legal_to_social"]),
    toUserId:uuid.optional(),toOfficeId:uuid.optional(),receivingOrgId:uuid.optional(),consentId:uuid.optional(),
    selectedInformation:z.record(z.string(),z.unknown()).default({}),restrictedInformation:z.record(z.string(),z.unknown()).default({}),
    summary:z.string().trim().min(3).max(10000),deadlines:z.array(z.unknown()).default([]),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,assigned_case_manager").eq("id",data.socialCaseId).single();fail(caseError);
    const {data:row,error}=await supabase.from("social_case_transfers").insert({org_id:c.org_id,social_case_id:data.socialCaseId,transfer_type:data.transferType,from_user_id:c.assigned_case_manager,to_user_id:data.toUserId??null,to_office_id:data.toOfficeId??null,receiving_org_id:data.receivingOrgId??null,consent_id:data.consentId??null,selected_information:data.selectedInformation,restricted_information:data.restrictedInformation,transfer_summary:data.summary,deadlines:data.deadlines,status:"pending_approval",created_by:userId}).select("id,status").single();fail(error);return row;
  });

export const acceptSocialTransfer=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({transferId:uuid}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("accept_social_transfer",{p_transfer:data.transferId});fail(error);return {ok:true};});

export const linkSocialImmigrationMatter=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    socialCaseId:uuid,immigrationCaseId:uuid,consentId:uuid,
    permittedStatusFields:z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    sharedSocialFields:z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    sharedDocumentIds:z.array(uuid).max(100).default([]),
    nonRefoulementConcern:z.boolean().default(false),detentionDeportationRisk:z.boolean().default(false),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id").eq("id",data.socialCaseId).single();fail(caseError);
    const {data:row,error}=await supabase.from("social_immigration_links").insert({org_id:c.org_id,social_case_id:data.socialCaseId,immigration_case_id:data.immigrationCaseId,consent_id:data.consentId,permitted_status_fields:data.permittedStatusFields,shared_social_fields:data.sharedSocialFields,shared_document_ids:data.sharedDocumentIds,non_refoulement_concern:data.nonRefoulementConcern,detention_deportation_risk:data.detentionDeportationRisk,created_by:userId}).select("id").single();fail(error);return row;
  });

export const getSocialIndicators=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,from:z.string().date(),to:z.string().date(),programId:uuid.optional(),officeId:uuid.optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);const {data:rows,error}=await supabase.rpc("social_indicator_summary",{p_org:data.orgId,p_from:data.from,p_to:data.to,p_program:data.programId??null,p_office:data.officeId??null});fail(error);return rows??[];
  });

export const prepareSocialDocumentUpload=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,socialCaseId:uuid,recordType:recordType,fileName:z.string().trim().min(1).max(240),mimeType:z.string().trim().max(200).optional(),sizeBytes:z.number().int().positive().max(104857600).optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:socialCase,error:caseError}=await supabase.from("social_cases")
      .select("org_id").eq("id",data.socialCaseId).single();
    fail(caseError);
    if(!socialCase?.org_id||socialCase.org_id!==data.orgId) throw new Error("Case does not belong to the selected organization");
    const mime=String(data.mimeType??"").toLowerCase().split(";")[0];
    const extension=data.fileName.toLowerCase().split(".").pop()??"";
    const allowedExtensions=new Set([
      "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","rtf","txt","csv","tsv","json","xml",
      "jpg","jpeg","png","webp","gif","bmp","tif","tiff","heic","heif","svg",
      "zip","rar","7z","tar","gz","tgz",
      "mp3","wav","m4a","aac","ogg","oga","flac","mp4","mov","m4v","webm","avi","mpeg","mpg","mkv",
      "eml","msg","dcm",
    ]);
    const blockedExtensions=new Set(["exe","dll","com","bat","cmd","msi","ps1","sh","js","mjs","cjs","html","htm","php","jar","apk","app","scr"]);
    if(blockedExtensions.has(extension)||!allowedExtensions.has(extension)) throw new Error("Unsupported or unsafe case-file format");
    const media=mime.startsWith("audio/")||mime.startsWith("video/")||["mp3","wav","m4a","aac","ogg","oga","flac","mp4","mov","m4v","webm","avi","mpeg","mpg","mkv"].includes(extension);
    if(media){
      const {data:programs,error:settingsError}=await supabase.from("social_programs").select("settings").eq("org_id",data.orgId).eq("active",true);fail(settingsError);
      if(!(programs??[]).some((p:any)=>p.settings?.allow_media_uploads!==false)) throw new Error("La carga de audio y video está deshabilitada para esta organización / Audio and video uploads are not enabled for this organization");
    }
    const safe=data.fileName.replace(/[^a-zA-Z0-9._-]+/g,"_");
    const path=`${socialCase.org_id}/${data.socialCaseId}/${data.recordType}/${crypto.randomUUID()}-${safe}`;
    const {data:signed,error}=await supabase.storage.from("social-case-files").createSignedUploadUrl(path);fail(error);
    return {path,token:signed.token,signedUrl:signed.signedUrl};
  });


export const ensureSocialProgram=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    orgId:uuid,nameEs:z.string().trim().min(2).max(160).default("Atención Integral"),
    nameEn:z.string().trim().min(2).max(160).default("Comprehensive Care"),
    prefix:z.string().trim().regex(/^[A-Z0-9-]{2,20}$/).default("NYR-SOC"),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:program,error}=await supabase.rpc("ensure_social_program_for_org",{
      p_org:data.orgId,p_name_es:data.nameEs,p_name_en:data.nameEn,p_prefix:data.prefix,
    });fail(error);return program;
  });


export const approveSocialCarePlan=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({planId:uuid,version:z.number().int().min(1)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("approve_social_care_plan",{p_plan:data.planId,p_version:data.version});fail(error);return {ok:true};});

export const assignSocialCaseManager=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid,userId:uuid,role:z.enum(["case_manager","supervisor","attorney","psychologist","social_worker"])}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("assign_social_case_manager",{p_case:data.caseId,p_user:data.userId,p_role:data.role});fail(error);return {ok:true};});

export const sendSocialReferral=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({referralId:uuid,purpose:z.string().trim().min(2).max(240),sharedFields:z.record(z.string(),z.unknown()),expiresAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("send_social_referral",{p_referral:data.referralId,p_purpose:data.purpose,p_shared_fields:data.sharedFields,p_expires:data.expiresAt??null});fail(error);return {ok:true};});

export const verifySocialReferralResult=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({referralId:uuid,result:z.string().trim().min(2).max(5000),response:z.string().trim().max(5000).optional(),closureReason:z.string().trim().max(1000).optional()}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("verify_social_referral_result",{p_referral:data.referralId,p_result:data.result,p_response:data.response??null,p_closure_reason:data.closureReason??null});fail(error);return {ok:true};});

export const advanceSocialTransfer=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({transferId:uuid,action:z.enum(["approve","send","reject"])}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("advance_social_transfer",{p_transfer:data.transferId,p_action:data.action});fail(error);return {ok:true};});

export const refreshSocialAlerts=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {data:created,error}=await supabase.rpc("refresh_social_case_alerts",{p_case:data.caseId});fail(error);return {created:created??0};});

export const acknowledgeSocialAlert=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({alertId:uuid,resolve:z.boolean().default(false)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const now=new Date().toISOString();const {error}=await supabase.from("social_alerts").update({acknowledged_at:now,...(data.resolve?{resolved_at:now}:{})}).eq("id",data.alertId);fail(error);return {ok:true};});

export const createSocialAppointment=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({socialCaseId:uuid,title:z.string().trim().min(2).max(300),scheduledAt:z.string().datetime(),durationMinutes:z.number().int().min(5).max(1440).optional(),locationMethod:z.string().trim().max(300).optional(),personId:uuid.optional()}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,person_id").eq("id",data.socialCaseId).single();fail(caseError);const {data:row,error}=await supabase.from("social_appointments").insert({org_id:c.org_id,social_case_id:data.socialCaseId,person_id:data.personId??c.person_id,title:data.title,scheduled_at:data.scheduledAt,duration_minutes:data.durationMinutes??null,location_method:data.locationMethod??null,professional_id:userId,status:"scheduled",created_by:userId}).select("id").single();fail(error);return row;});

export const getSocialCaseMediaGallery=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases")
      .select("id,org_id,created_by,assigned_case_manager,supervising_manager")
      .eq("id",data.caseId).single();
    fail(caseError);
    const {data:account,error:accountError}=await supabase.rpc("get_social_organization_account",{p_org:c.org_id});
    if(accountError)console.warn("Unable to resolve organization media authority",accountError.message);
    const canManage=(account as any)?.can_manage===true;
    const isDirectlyAuthorized=[c.created_by,c.assigned_case_manager,c.supervising_manager].filter(Boolean).includes(userId);
    if(!canManage&&!isDirectlyAuthorized)throw new Error("Only the assigning manager and assigned case worker may view case media");
    const {data:documents,error}=await supabase.from("social_documents")
      .select("id,title,document_type,record_type,sensitivity,current_version,checksum,mime_type,size_bytes,storage_path,extraction_authorized,created_at")
      .eq("social_case_id",data.caseId).is("deleted_at",null).order("created_at",{ascending:false});
    fail(error);
    const media=(documents??[]).filter((document:any)=>/^(image|video|audio)\//i.test(document.mime_type??""));
    const signed=await Promise.all(media.map(async(document:any)=>{
      const {data:signedData,error:signedError}=await supabase.storage.from("social-case-files").createSignedUrl(document.storage_path,300);
      if(signedError)return null;
      return {...document,storage_path:undefined,signedUrl:signedData.signedUrl,expiresAt:new Date(Date.now()+300000).toISOString()};
    }));
    return signed.filter(Boolean);
  });

export const setSocialDocumentAiAccess=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,allowed:z.boolean()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:document,error:documentError}=await supabase.from("social_documents")
      .select("id,org_id,social_case_id").eq("id",data.documentId).is("deleted_at",null).single();
    fail(documentError);
    const {data:c,error:caseError}=await supabase.from("social_cases")
      .select("created_by,assigned_case_manager,supervising_manager").eq("id",document.social_case_id).single();
    fail(caseError);
    const {data:account,error:accountError}=await supabase.rpc("get_social_organization_account",{p_org:document.org_id});
    if(accountError)console.warn("Unable to resolve organization AI authority",accountError.message);
    const canManage=(account as any)?.can_manage===true;
    const isDirectlyAuthorized=[c.created_by,c.assigned_case_manager,c.supervising_manager].filter(Boolean).includes(userId);
    if(!canManage&&!isDirectlyAuthorized)throw new Error("Only the assigning manager and assigned case worker may authorize case AI");
    const {data:updated,error}=await supabase.from("social_documents").update({extraction_authorized:data.allowed}).eq("id",data.documentId).select("id").single();
    fail(error);if(!updated)throw new Error("The document AI permission could not be updated");
    await supabase.from("social_activity_events").insert({
      org_id:document.org_id,social_case_id:document.social_case_id,actor_id:userId,
      event_type:"case_media_ai_access_changed",entity_type:"social_document",entity_id:document.id,
      metadata:{allowed:data.allowed,scope:"comprehensive_care_only"},
    });
    return {ok:true,allowed:data.allowed};
  });

export const finalizeSocialDocumentUpload=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({socialCaseId:uuid,path:z.string().min(20).max(1000),title:z.string().trim().min(1).max(300),documentType:z.string().trim().max(120).optional(),recordType:recordType,sensitivity:z.enum(["standard","confidential","restricted","highly_restricted"]).default("confidential"),consentId:uuid.optional(),extractionAuthorized:z.boolean().default(false),mimeType:z.string().trim().max(200).optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("person_id,family_id").eq("id",data.socialCaseId).single();fail(caseError);
    const {data:file,error:downloadError}=await supabase.storage.from("social-case-files").download(data.path);fail(downloadError);
    const bytes=await file.arrayBuffer();const digest=await crypto.subtle.digest("SHA-256",bytes);
    const checksum=Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2,"0")).join("");
    const {data:duplicate,error:duplicateError}=await supabase.from("social_documents").select("id,title,current_version").eq("social_case_id",data.socialCaseId).eq("checksum",checksum).is("deleted_at",null).maybeSingle();fail(duplicateError);
    if(duplicate){await supabase.storage.from("social-case-files").remove([data.path]);return {documentId:duplicate.id,checksum,size:file.size,duplicate:true,duplicateTitle:duplicate.title};}
    const {data:documentId,error}=await supabase.rpc("register_social_document",{p_case:data.socialCaseId,p_person:c.person_id,p_family:c.family_id,p_title:data.title,p_document_type:data.documentType??null,p_record_type:data.recordType,p_sensitivity:data.sensitivity,p_consent:data.consentId??null,p_storage_path:data.path,p_checksum:checksum,p_mime:data.mimeType||file.type||null,p_size:file.size,p_extraction_authorized:data.extractionAuthorized});
    fail(error);return {documentId,checksum,size:file.size,duplicate:false};
  });


const socialRole=z.enum(["organization_owner","program_director","case_management_supervisor","case_manager","social_worker","attorney","legal_assistant","psychologist","medical_professional","referral_coordinator","data_analyst","auditor","read_only_reviewer","external_partner"]);

export const upsertSocialRoleAssignment=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,userId:uuid,role:socialRole,scopeType:z.enum(["organization","program","office","case"]).default("organization"),scopeId:uuid.optional(),endsAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    let existing=supabase.from("social_role_assignments").select("id").eq("org_id",data.orgId).eq("user_id",data.userId).eq("role",data.role).eq("scope_type",data.scopeType);
    existing=data.scopeId?existing.eq("scope_id",data.scopeId):existing.is("scope_id",null);
    const {data:row,error:lookupError}=await existing.maybeSingle();fail(lookupError);
    if(row?.id){const {error}=await supabase.from("social_role_assignments").update({active:true,ends_at:data.endsAt??null,assigned_by:userId}).eq("id",row.id);fail(error);return {id:row.id};}
    const {data:created,error}=await supabase.from("social_role_assignments").insert({org_id:data.orgId,user_id:data.userId,role:data.role,scope_type:data.scopeType,scope_id:data.scopeId??null,active:true,ends_at:data.endsAt??null,assigned_by:userId}).select("id").single();fail(error);return created;
  });

export const grantSocialRecordAccess=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid,userId:uuid,recordType:recordType,canWrite:z.boolean().default(false),reason:z.string().trim().min(5).max(1000),expiresAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id").eq("id",data.caseId).single();fail(caseError);
    const {data:row,error}=await supabase.from("social_record_grants").insert({org_id:c.org_id,social_case_id:data.caseId,user_id:data.userId,record_type:data.recordType,can_read:true,can_write:data.canWrite,expires_at:data.expiresAt??null,granted_by:userId,reason:data.reason}).select("id").single();fail(error);return row;
  });

export const shareSocialDocument=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,receivingOrgId:uuid,consentId:uuid,purpose:z.string().trim().min(2).max(300),expiresAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:document,error:documentError}=await supabase.from("social_documents").select("org_id,external_shareable").eq("id",data.documentId).single();fail(documentError);if(!document.external_shareable) throw new Error("Document must be explicitly marked external-shareable before consent-based sharing");
    const {data:row,error}=await supabase.from("social_document_shares").insert({org_id:document.org_id,document_id:data.documentId,receiving_org_id:data.receivingOrgId,consent_id:data.consentId,purpose:data.purpose,expires_at:data.expiresAt??null,created_by:userId}).select("id").single();fail(error);return row;
  });


const resourceSearchInput=z.object({
  query:z.string().trim().max(200).optional(),state:z.string().trim().max(10).optional(),municipality:z.string().trim().max(120).optional(),
  latitude:z.number().min(-90).max(90).optional(),longitude:z.number().min(-180).max(180).optional(),radiusKm:z.number().positive().max(1000).optional(),
  service:z.string().trim().max(100).optional(),urgency:z.enum(["standard","urgent","emergency"]).optional(),
  population:z.string().trim().max(100).optional(),language:z.string().trim().max(80).optional(),
  costType:z.enum(["free","sliding_scale","paid","public_coverage","unknown"]).optional(),availability:z.string().trim().max(60).optional(),
});

export const searchResourceNetwork=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>resourceSearchInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:rows,error}=await supabase.rpc("search_resource_network",{
      p_query:data.query||null,p_state:data.state||null,p_municipality:data.municipality||null,
      p_latitude:data.latitude??null,p_longitude:data.longitude??null,p_radius_km:data.radiusKm??null,
      p_service:data.service||null,p_urgency:data.urgency||null,p_population:data.population||null,
      p_language:data.language||null,p_cost_type:data.costType||null,p_availability:data.availability||null,p_limit:60,
    });
    fail(error);return rows??[];
  });

export const findResourcesForSocialCase=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid,service:z.string().trim().max(100).optional(),urgency:z.enum(["standard","urgent","emergency"]).optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("id,org_id,service_areas,risk_level,person_id,family_id").eq("id",data.caseId).single();fail(caseError);
    const {data:person,error:personError}=await supabase.from("social_people").select("current_location,languages,nationality").eq("id",c.person_id).maybeSingle();
    if(personError&&personError.code!=="PGRST116")fail(personError);
    const location=(person?.current_location??{}) as Record<string,unknown>;
    const service=data.service||c.service_areas?.[0]||undefined;
    const urgency=data.urgency||(c.risk_level==="critical"?"emergency":c.risk_level==="high"?"urgent":"standard");
    const {data:rows,error}=await supabase.rpc("search_resource_network",{
      p_query:null,p_state:typeof location.state_code==="string"?location.state_code:null,
      p_municipality:typeof location.municipality==="string"?location.municipality:null,
      p_latitude:typeof location.latitude==="number"?location.latitude:null,p_longitude:typeof location.longitude==="number"?location.longitude:null,
      p_radius_km:null,p_service:service??null,p_urgency:urgency,p_population:null,
      p_language:Array.isArray(person?.languages)?person.languages[0]??null:null,p_cost_type:null,p_availability:null,p_limit:25,
    });
    fail(error);
    return {recommendations:rows??[],context:{service,urgency,locationUsed:Boolean(location.state_code||location.municipality)},notice:"Recommendations are ranked from authorized case fields. Staff must review eligibility, availability, consent, and final suitability."};
  });

export const getResourceNetworkMetadata=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .handler(async({context})=>{
    const {supabase}=ctx(context);
    const [categories,knowledge,organizations,cases]=await Promise.all([
      supabase.from("resource_service_categories").select("id,org_id,code,name_es,name_en,description_es,description_en,sort_order").eq("active",true).order("sort_order"),
      supabase.from("resource_knowledge_records").select("id,org_id,title_es,title_en,summary_es,summary_en,knowledge_type,service_categories,state_codes,municipality,population_tags,source_url,document_path,version,approval_status,effective_at,review_due_at,internal_only,updated_at").order("updated_at",{ascending:false}).limit(250),
      supabase.from("organizations").select("id,name").order("name"),
      supabase.from("social_cases").select("id,org_id,case_number,status,person_id,family_id").is("deleted_at",null).order("last_activity_at",{ascending:false}).limit(250),
    ]);
    fail(categories.error);fail(knowledge.error);fail(organizations.error);fail(cases.error);
    return {categories:categories.data??[],knowledge:knowledge.data??[],organizations:organizations.data??[],cases:cases.data??[]};
  });

export const getResourceContactContext=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("id,org_id,case_number,person_id,family_id").eq("id",data.caseId).single();fail(caseError);
    let consentQuery=supabase.from("social_consents").select("id,consent_type,status,expires_at,current_version,social_consent_versions(permitted_purpose,permitted_recipients,permitted_information)").eq("status","active").order("created_at",{ascending:false});
    consentQuery=c.person_id?consentQuery.eq("person_id",c.person_id):consentQuery.eq("family_id",c.family_id);
    const [documents,consents]=await Promise.all([
      supabase.from("social_documents").select("id,title,document_type,external_shareable,consent_id").eq("social_case_id",c.id).eq("external_shareable",true).is("deleted_at",null).order("created_at",{ascending:false}),
      consentQuery,
    ]);fail(documents.error);fail(consents.error);
    return {case:c,documents:documents.data??[],consents:(consents.data??[]).filter((x:any)=>!x.expires_at||new Date(x.expires_at)>new Date())};
  });

const communicationInput=z.object({
  caseId:uuid,institutionId:uuid,referralId:uuid.optional(),type:z.enum(["email","message","phone","website_portal"]),
  recipient:z.string().trim().min(2).max(500),subject:z.string().trim().min(2).max(500),message:z.string().max(20000).optional(),
  documentIds:z.array(uuid).max(20).default([]),consentId:uuid.optional(),status:z.enum(["attempted","completed"]).optional(),
});

export const sendResourceCommunication=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>communicationInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);
    const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,case_number").eq("id",data.caseId).single();fail(caseError);
    const {data:documents,error:docError}=await supabase.from("social_documents").select("id,title").eq("social_case_id",data.caseId).in("id",data.documentIds);fail(docError);
    if((documents??[]).length!==data.documentIds.length)throw new Error("A selected document is not available in this case");
    const initial="draft";
    const {data:row,error}=await supabase.from("social_resource_communications").insert({org_id:c.org_id,social_case_id:data.caseId,institution_id:data.institutionId,referral_id:data.referralId??null,sender_id:userId,recipient:data.recipient,subject:data.subject,communication_type:data.type,message:data.message??null,document_ids:data.documentIds,consent_id:data.consentId??null,status:initial}).select("id").single();fail(error);
    if(data.type!=="email"){
      const {error:updateError}=await supabase.from("social_resource_communications").update({status:data.status??"attempted",sent_at:new Date().toISOString()}).eq("id",row.id);fail(updateError);return {id:row.id,status:data.status??"attempted"};
    }
    try{
      const {sendTemplateEmail}=await import("@/lib/email-templates/send-email");
      const result=await sendTemplateEmail("resource-contact",data.recipient,{idempotencyKey:row.id,templateData:{subject:data.subject,message:data.message,caseReference:c.case_number,documents:(documents??[]).map((x:any)=>x.title)}});
      const status=result.sent?"sent":"failed";
      const {error:updateError}=await supabase.from("social_resource_communications").update({status,sent_at:result.sent?new Date().toISOString():null,delivery_detail:result.sent?null:result.reason}).eq("id",row.id);fail(updateError);
      return {id:row.id,status};
    }catch(error){
      await supabase.from("social_resource_communications").update({status:"failed",delivery_detail:error instanceof Error?error.message:"Delivery failed"}).eq("id",row.id);
      throw error;
    }
  });

export const createResourceReferral=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>referralInput.extend({notes:z.string().max(5000).optional(),followUpAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const {data:c,error:caseError}=await supabase.from("social_cases").select("org_id,person_id,family_id").eq("id",data.socialCaseId).single();fail(caseError);
    const status=data.consentId?"draft":"awaiting_consent";
    const {data:row,error}=await supabase.from("social_referrals").insert({org_id:c.org_id,social_case_id:data.socialCaseId,referral_number:null,person_id:data.personId??c.person_id,family_id:data.familyId??c.family_id,receiving_institution_id:data.institutionId,service_requested:data.serviceRequested,reason:data.reason,urgency:data.urgency,consent_id:data.consentId??null,authorized_information:data.authorizedInformation,status,notes:data.notes??null,follow_up_date:data.followUpAt?.slice(0,10)??null,created_by:userId}).select("id,referral_number,status").single();fail(error);
    if(data.followUpAt){const {error:taskError}=await supabase.from("social_tasks").insert({org_id:c.org_id,social_case_id:data.socialCaseId,title:`Referral follow-up: ${data.serviceRequested}`,description:data.notes??data.reason,assignee_id:userId,priority:data.urgency,status:"todo",due_at:data.followUpAt,reminder_at:data.followUpAt,created_by:userId});fail(taskError);}
    return row;
  });

const resourceAdminInput=z.object({
  id:uuid.optional(),orgId:uuid.nullable().optional(),officialName:z.string().trim().min(2).max(240),institutionType:z.string().trim().min(2).max(100),
  description:z.string().trim().max(3000).optional(),services:z.array(z.string().trim().min(1).max(100)).max(50).default([]),stateCode:z.string().trim().max(10).optional(),
  municipality:z.string().trim().max(120).optional(),address:z.string().trim().max(500).optional(),latitude:z.number().min(-90).max(90).optional(),longitude:z.number().min(-180).max(180).optional(),
  phone:z.string().trim().max(80).optional(),whatsapp:z.string().trim().max(80).optional(),email:z.string().email().optional().or(z.literal("")),website:z.string().url().optional().or(z.literal("")),
  languages:z.array(z.string()).max(30).default([]),populations:z.array(z.string()).max(50).default([]),eligibility:z.string().max(3000).optional(),requiredDocuments:z.array(z.string()).max(50).default([]),
  costType:z.enum(["free","sliding_scale","paid","public_coverage","unknown"]).default("unknown"),appointmentRequired:z.boolean().default(false),walkInAvailable:z.boolean().default(false),
  emergencyAvailable:z.boolean().default(false),remoteAvailable:z.boolean().default(false),referralMethods:z.array(z.string()).max(30).default([]),coverageLevels:z.array(z.string()).max(10).default([]),
  capacityStatus:z.string().max(60).default("unknown"),locationConfidential:z.boolean().default(false),publicNotes:z.string().max(3000).optional(),internalNotes:z.string().max(5000).optional(),
});

export const saveResourceInstitution=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>resourceAdminInput.parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const payload={org_id:data.orgId??null,name:data.officialName,official_name:data.officialName,institution_type:data.institutionType,description:data.description||null,services:data.services,
      state_code:data.stateCode||null,municipality:data.municipality||null,address:data.address||null,latitude:data.latitude??null,longitude:data.longitude??null,phone:data.phone||null,whatsapp:data.whatsapp||null,
      email:data.email||null,website:data.website||null,languages:data.languages,populations:data.populations,eligibility:data.eligibility||null,required_documents:data.requiredDocuments,cost_type:data.costType,
      appointment_required:data.appointmentRequired,walk_in_available:data.walkInAvailable,emergency_available:data.emergencyAvailable,remote_available:data.remoteAvailable,
      referral_methods:data.referralMethods,coverage_levels:data.coverageLevels,capacity_status:data.capacityStatus,location_confidential:data.locationConfidential,
      public_notes:data.publicNotes||null,internal_notes:data.internalNotes||null,active:true,updated_at:new Date().toISOString()};
    const query=data.id?supabase.from("social_institutions").update(payload).eq("id",data.id):supabase.from("social_institutions").insert(payload);
    const {data:row,error}=await query.select("id,official_name,status").single();fail(error);return row;
  });

export const verifyResourceInstitution=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({institutionId:uuid,status:z.enum(["verified","verification_due","unverified","temporarily_unavailable","at_capacity","closed","archived"]),source:z.string().trim().min(2).max(500),evidenceUrl:z.string().url().optional().or(z.literal("")),notes:z.string().max(2000).optional(),nextVerificationAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);const {data:id,error}=await supabase.rpc("verify_resource",{p_institution:data.institutionId,p_status:data.status,p_source:data.source,p_evidence_url:data.evidenceUrl||null,p_notes:data.notes||null,p_next_verification:data.nextVerificationAt||null});fail(error);return {verificationId:id};
  });

export const submitResourceCorrection=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({institutionId:uuid,orgId:uuid.nullable().optional(),fieldName:z.string().max(100).optional(),suggestedValue:z.string().max(2000).optional(),reason:z.string().trim().min(5).max(2000)}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const {data:row,error}=await supabase.from("resource_corrections").insert({institution_id:data.institutionId,org_id:data.orgId??null,field_name:data.fieldName||null,suggested_value:data.suggestedValue||null,reason:data.reason,submitted_by:userId}).select("id,status").single();fail(error);return row;
  });

export const saveResourceKnowledge=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({id:uuid.optional(),orgId:uuid.nullable().optional(),titleEs:z.string().trim().min(2).max(240),titleEn:z.string().trim().min(2).max(240),summaryEs:z.string().max(5000).optional(),summaryEn:z.string().max(5000).optional(),knowledgeType:z.enum(["procedure","protocol","manual","form","legal_update","service_guide","institution_note"]),serviceCategories:z.array(z.string()).max(50).default([]),stateCodes:z.array(z.string()).max(40).default([]),sourceUrl:z.string().url().optional().or(z.literal("")),approvalStatus:z.enum(["draft","in_review","approved","retired"]).default("draft"),reviewDueAt:z.string().datetime().optional()}).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const payload={org_id:data.orgId??null,title_es:data.titleEs,title_en:data.titleEn,summary_es:data.summaryEs||null,summary_en:data.summaryEn||null,knowledge_type:data.knowledgeType,service_categories:data.serviceCategories,state_codes:data.stateCodes,source_url:data.sourceUrl||null,approval_status:data.approvalStatus,review_due_at:data.reviewDueAt||null,created_by:userId,approved_by:data.approvalStatus==="approved"?userId:null,approved_at:data.approvalStatus==="approved"?new Date().toISOString():null,updated_at:new Date().toISOString()};
    const query=data.id?supabase.from("resource_knowledge_records").update(payload).eq("id",data.id):supabase.from("resource_knowledge_records").insert(payload);
    const {data:row,error}=await query.select("id,version,approval_status").single();fail(error);return row;
  });



export const getSocialDocumentWorkspace=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const caseRow=await supabase.from("social_cases").select("id,org_id,case_number,status,risk_level,assigned_case_manager,consent_status,person_id,family_id,program_id").eq("id",data.caseId).single();fail(caseRow.error);
    const c=caseRow.data;
    const [person,family,inventory,consents,shares,events,versions,referrals,assessments,plans,requirements]=await Promise.all([
      c.person_id?supabase.from("social_people").select("id,legal_name,preferred_name,consent_status").eq("id",c.person_id).maybeSingle():Promise.resolve({data:null,error:null}),
      c.family_id?supabase.from("social_families").select("id,family_name,family_number").eq("id",c.family_id).maybeSingle():Promise.resolve({data:null,error:null}),
      supabase.rpc("social_document_inventory",{p_case:data.caseId}),
      supabase.from("social_consents").select("*,social_consent_versions(*)").or([c.person_id?`person_id.eq.${c.person_id}`:null,c.family_id?`family_id.eq.${c.family_id}`:null].filter(Boolean).join(",")).order("created_at",{ascending:false}),
      supabase.from("social_document_shares").select("*").eq("org_id",c.org_id).order("created_at",{ascending:false}),
      supabase.from("social_document_access_events").select("*").eq("social_case_id",data.caseId).order("occurred_at",{ascending:false}).limit(300),
      supabase.from("social_document_versions").select("*").eq("org_id",c.org_id).order("created_at",{ascending:false}),
      supabase.from("social_referrals").select("id,referral_number,status,service_requested").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_assessments").select("id,risk_level,assessment_date").eq("social_case_id",data.caseId).order("assessment_date",{ascending:false}),
      supabase.from("social_care_plans").select("id,status,created_at").eq("social_case_id",data.caseId).order("created_at",{ascending:false}),
      supabase.from("social_case_document_requirements").select("*").eq("social_case_id",data.caseId).order("due_at",{ascending:true}),
    ]);
    [person,family,inventory,consents,shares,events,versions,referrals,assessments,plans,requirements].forEach((x:any)=>fail(x.error));
    const docs=inventory.data??[];const ids=new Set(docs.map((x:any)=>x.id));
    return {case:c,person:person.data,family:family.data,documents:docs,
      consents:consents.data??[],shares:(shares.data??[]).filter((x:any)=>ids.has(x.document_id)),
      events:events.data??[],versions:(versions.data??[]).filter((x:any)=>ids.has(x.document_id)),
      referrals:referrals.data??[],assessments:assessments.data??[],plans:plans.data??[],requirements:requirements.data??[]};
  });

export const updateSocialDocumentMetadata=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,title:z.string().trim().min(1).max(300),documentType:z.string().trim().min(1).max(120),recordType:recordType,sensitivity:z.enum(["standard","confidential","restricted","highly_restricted"]),description:z.string().max(3000).optional(),tags:z.array(z.string().trim().min(1).max(80)).max(50).default([]),status:z.enum(["active","superseded","archived"]),classificationStatus:z.enum(["suggested","classified","needs_review"]),expiresAt:z.string().datetime().optional(),externalShareable:z.boolean().default(false),linkedEntities:z.object({referral_id:uuid.optional(),assessment_id:uuid.optional(),care_plan_id:uuid.optional()}).strict().default({})}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.rpc("update_social_document_metadata",{p_document:data.documentId,p_title:data.title,p_document_type:data.documentType,p_record_type:data.recordType,p_sensitivity:data.sensitivity,p_description:data.description??null,p_tags:data.tags,p_status:data.status,p_classification_status:data.classificationStatus,p_expires_at:data.expiresAt??null,p_external_shareable:data.externalShareable,p_linked_entities:data.linkedEntities});fail(error);return {ok:true};});

export const finalizeSocialDocumentVersionUpload=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,path:z.string().min(20).max(1000),notes:z.string().trim().min(2).max(1000),mimeType:z.string().max(200).optional()}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const downloaded=await supabase.storage.from("social-case-files").download(data.path);fail(downloaded.error);const file=downloaded.data;const bytes=await file.arrayBuffer();const digest=await crypto.subtle.digest("SHA-256",bytes);const checksum=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");const {data:version,error}=await supabase.rpc("add_social_document_version",{p_document:data.documentId,p_storage_path:data.path,p_checksum:checksum,p_mime:data.mimeType||file.type||null,p_size:file.size,p_notes:data.notes});fail(error);return {version,checksum,size:file.size};});

export const getSocialDocumentAccessUrl=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,action:z.enum(["preview","download"]),reason:z.string().trim().max(500).optional()}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const document=await supabase.from("social_documents").select("id,org_id,social_case_id,current_version,storage_path,title").eq("id",data.documentId).single();fail(document.error);const signed=await supabase.storage.from("social-case-files").createSignedUrl(document.data.storage_path,120,{download:data.action==="download"?document.data.title:undefined});fail(signed.error);const event=await supabase.from("social_document_access_events").insert({org_id:document.data.org_id,social_case_id:document.data.social_case_id,document_id:document.data.id,version:document.data.current_version,action:data.action,reason:data.reason??null,actor_id:userId});fail(event.error);return {url:signed.data.signedUrl,expiresIn:120};});

export const moveSocialDocument=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({documentId:uuid,targetCaseId:uuid,reason:z.string().trim().min(3).max(1000)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);
    const document=await supabase.from("social_documents").select("id,org_id,social_case_id,record_type,storage_path,checksum,mime_type,size_bytes").eq("id",data.documentId).single();fail(document.error);
    const target=await supabase.from("social_cases").select("id,org_id").eq("id",data.targetCaseId).single();fail(target.error);
    if(document.data.org_id!==target.data.org_id) throw new Error("Document cannot move outside its organization");
    const downloaded=await supabase.storage.from("social-case-files").download(document.data.storage_path);fail(downloaded.error);
    const file=downloaded.data;const name=document.data.storage_path.split("/").pop()?.replace(/^[^-]+-/,"")||"document";
    const targetPath=`${document.data.org_id}/${target.data.id}/${document.data.record_type}/${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]+/g,"_")}`;
    const uploaded=await supabase.storage.from("social-case-files").upload(targetPath,file,{contentType:document.data.mime_type||file.type||undefined,upsert:false});fail(uploaded.error);
    const {error}=await supabase.rpc("move_social_document",{p_document:data.documentId,p_target_case:data.targetCaseId,p_new_storage_path:targetPath,p_checksum:document.data.checksum,p_mime:document.data.mime_type||file.type||null,p_size:document.data.size_bytes||file.size,p_reason:data.reason});fail(error);
    return {ok:true};
  });


const knowledgeStatus=z.enum(["draft","pending_review","approved","published","revision_required","expired","archived"]);
const knowledgeType=z.enum(["procedure","protocol","intake_manual","risk_guidance","care_plan_instruction","consent_template","referral_instruction","emergency_procedure","immigration_guidance","state_municipal_guidance","official_form","training_material","document_checklist","legal_update","institutional_policy","faq","manual","form","service_guide","institution_note"]);

export const getKnowledgeCenter=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .handler(async({context})=>{
    const {supabase}=ctx(context);
    const [records,cases,corrections,usage]=await Promise.all([
      supabase.from("resource_knowledge_records").select("*").order("updated_at",{ascending:false}).limit(500),
      supabase.from("social_cases").select("id,case_number,status").order("last_activity_at",{ascending:false}).limit(250),
      supabase.from("resource_knowledge_corrections").select("*").order("created_at",{ascending:false}).limit(250),
      supabase.from("resource_knowledge_usage").select("knowledge_id,action,created_at").order("created_at",{ascending:false}).limit(1000),
    ]);
    [records,cases,corrections,usage].forEach((x:any)=>fail(x.error));
    return {records:records.data??[],cases:cases.data??[],corrections:corrections.data??[],usage:usage.data??[]};
  });

export const saveKnowledgeRecord=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    id:uuid.optional(),orgId:uuid,titleEs:z.string().trim().min(2).max(240),titleEn:z.string().trim().min(2).max(240),
    summaryEs:z.string().max(5000).optional(),summaryEn:z.string().max(5000).optional(),contentEs:z.string().max(50000).optional(),contentEn:z.string().max(50000).optional(),
    knowledgeType,serviceCategories:z.array(z.string()).max(50).default([]),stateCodes:z.array(z.string()).max(40).default([]),municipality:z.string().max(120).optional(),
    authority:z.string().max(300).optional(),languageCodes:z.array(z.string()).max(20).default(["es"]),effectiveAt:z.string().datetime().optional(),
    reviewDueAt:z.string().datetime().optional(),approvalStatus:knowledgeStatus,audience:z.enum(["internal_staff","official_government","client_facing","case_evidence_reference"]),
    sourceUrl:z.string().url().optional().or(z.literal("")),purpose:z.string().max(5000).optional(),whenToUse:z.string().max(5000).optional(),
    applicablePrograms:z.array(z.string()).max(50).default([]),requiredSteps:z.array(z.string()).max(100).default([]),officialSources:z.array(z.object({title:z.string().max(300),url:z.string().url()})).max(50).default([]),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase,userId}=ctx(context);const now=new Date().toISOString();
    const current=data.id?await supabase.from("resource_knowledge_records").select("version").eq("id",data.id).single():null;if(current)fail(current.error);const nextVersion=data.id?(current!.data.version+1):1;
    const payload={org_id:data.orgId,version:nextVersion,title_es:data.titleEs,title_en:data.titleEn,summary_es:data.summaryEs||null,summary_en:data.summaryEn||null,
      content_es:data.contentEs||null,content_en:data.contentEn||null,knowledge_type:data.knowledgeType,service_categories:data.serviceCategories,
      state_codes:data.stateCodes,municipality:data.municipality||null,authority:data.authority||null,language_codes:data.languageCodes,
      effective_at:data.effectiveAt||null,review_due_at:data.reviewDueAt||null,approval_status:data.approvalStatus,audience:data.audience,
      source_url:data.sourceUrl||null,purpose:data.purpose||null,when_to_use:data.whenToUse||null,applicable_programs:data.applicablePrograms,
      required_steps:data.requiredSteps,official_sources:data.officialSources,owner_id:userId,updated_at:now,
      approved_by:["approved","published"].includes(data.approvalStatus)?userId:null,approved_at:["approved","published"].includes(data.approvalStatus)?now:null,
      archived_at:data.approvalStatus==="archived"?now:null};
    const query=data.id?supabase.from("resource_knowledge_records").update(payload).eq("id",data.id):supabase.from("resource_knowledge_records").insert({...payload,created_by:userId});
    const {data:row,error}=await query.select("id,version,approval_status").single();fail(error);
    if(data.id){const version=await supabase.from("resource_knowledge_versions").insert({knowledge_id:data.id,version:row.version,snapshot:payload,change_summary:"Knowledge record updated",created_by:userId});fail(version.error);}
    return row;
  });

export const prepareKnowledgeUpload=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,recordId:uuid,fileName:z.string().min(1).max(255)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const safe=data.fileName.replace(/[^a-zA-Z0-9._-]+/g,"_");const path=`${data.orgId}/${data.recordId}/${crypto.randomUUID()}-${safe}`;const signed=await supabase.storage.from("social-knowledge-files").createSignedUploadUrl(path);fail(signed.error);return {path,token:signed.data.token};});

export const finalizeKnowledgeUpload=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({recordId:uuid,path:z.string().min(20).max(1000),fileType:z.string().max(120)}).parse(d))
  .handler(async({data,context})=>{const {supabase}=ctx(context);const {error}=await supabase.from("resource_knowledge_records").update({document_path:data.path,file_type:data.fileType,updated_at:new Date().toISOString()}).eq("id",data.recordId);fail(error);return {ok:true};});

export const openKnowledgeRecord=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({recordId:uuid,download:z.boolean().default(false)}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const rec=await supabase.from("resource_knowledge_records").select("id,org_id,document_path,title_es").eq("id",data.recordId).single();fail(rec.error);let url:string|null=null;if(rec.data.document_path){const signed=await supabase.storage.from("social-knowledge-files").createSignedUrl(rec.data.document_path,120,{download:data.download?rec.data.title_es:undefined});fail(signed.error);url=signed.data.signedUrl;}const log=await supabase.from("resource_knowledge_usage").insert({knowledge_id:data.recordId,org_id:rec.data.org_id,action:data.download?"download":"open",actor_id:userId});fail(log.error);return {url};});

export const actOnKnowledgeRecord=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({recordId:uuid,caseId:uuid,action:z.enum(["attach_reference","add_required_form","create_checklist","create_task","find_related_resources","start_referral","share_client_version","ask_talk_to_case"]),details:z.record(z.string(),z.unknown()).default({})}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const rec=await supabase.from("resource_knowledge_records").select("org_id,audience,approval_status").eq("id",data.recordId).single();fail(rec.error);if(!["approved","published"].includes(rec.data.approval_status))throw new Error("Only approved knowledge can be used with a case");if(data.action==="share_client_version"&&rec.data.audience!=="client_facing")throw new Error("Only client-facing material may be shared");const row=await supabase.from("resource_knowledge_case_actions").insert({knowledge_id:data.recordId,org_id:rec.data.org_id,social_case_id:data.caseId,action_type:data.action,details:{...data.details,legal_evidence:false},created_by:userId});fail(row.error);return {ok:true};});

export const submitKnowledgeCorrection=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({recordId:uuid,suggestion:z.string().trim().min(5).max(5000)}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const rec=await supabase.from("resource_knowledge_records").select("org_id").eq("id",data.recordId).single();fail(rec.error);const row=await supabase.from("resource_knowledge_corrections").insert({knowledge_id:data.recordId,org_id:rec.data.org_id,suggestion:data.suggestion,submitted_by:userId});fail(row.error);return {ok:true};});


const careActionType=z.enum(["create_task","add_to_care_plan","request_document","start_risk_reassessment","find_resource","create_referral","schedule_follow_up","supervisor_review","request_legal_review","draft_case_summary","prepare_closure_checklist"]);

export const askTalkToCareCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    caseId: uuid,
    question: z.string().trim().min(2).max(3000),
    language: z.enum(["es", "en"]).default("es"),
    healthCheck: z.boolean().default(false),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const {
      buildCareHealth, buildFactSheet, careAssistantSystem,
      buildDeterministicAnswer, localizeAssistantLabels,
    } = await import("@/lib/social/care-assistant.server");

    // Case row is mandatory
    const caseRow = await supabase.from("social_cases").select("*").eq("id", data.caseId).single();
    fail(caseRow.error);
    const sc = caseRow.data;

    // Optional subsections safely unwrap without crashing if a non-critical table query fails
    const [
      personRes, familyRes, intakesRes, assessmentsRes, plansRes,
      interventionsRes, tasksRes, referralsRes, documentsRes,
      consentsRes, requirementsRes, knowledgeRes, resourcesRes,
    ] = await Promise.all([
      sc.person_id ? supabase.from("social_people").select("id,person_number,legal_name,consent_status").eq("id", sc.person_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      sc.family_id ? supabase.from("social_families").select("id,family_number,family_name").eq("id", sc.family_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      supabase.from("social_intakes").select("id,intake_number,status,summary,presenting_needs,created_at,completed_at").eq("social_case_id", data.caseId).order("created_at", { ascending: false }),
      supabase.from("social_assessments").select("id,risk_level,assessment_date,current_version").eq("social_case_id", data.caseId).order("assessment_date", { ascending: false }),
      supabase.from("social_care_plans").select("id,status,current_version,social_care_plan_versions(version,summary,social_care_plan_goals(id,status,goal,target_date))").eq("social_case_id", data.caseId).order("created_at", { ascending: false }),
      supabase.from("social_interventions").select("id,service_type,occurred_at,reason,actions_taken,outcome,follow_up_required,care_plan_goal_id").eq("social_case_id", data.caseId).eq("record_type", "general_case_record").order("occurred_at", { ascending: false }).limit(50),
      supabase.from("social_tasks").select("id,title,status,priority,due_at,assignee_id").eq("social_case_id", data.caseId).order("due_at", { ascending: true }),
      supabase.from("social_referrals").select("id,referral_number,status,service_requested,created_at,updated_at").eq("social_case_id", data.caseId).order("created_at", { ascending: false }),
      supabase.from("social_documents").select("id,title,document_type,current_version,created_at").eq("social_case_id", data.caseId).eq("record_type", "general_case_record").is("deleted_at", null),
      supabase.from("social_consents").select("id,consent_type,status,expires_at,current_version").or(`person_id.eq.${sc.person_id}${sc.family_id ? ",family_id.eq." + sc.family_id : ""}`).order("created_at", { ascending: false }),
      supabase.from("social_case_document_requirements").select("id,document_type,status,due_at").eq("social_case_id", data.caseId),
      supabase.from("resource_knowledge_records").select("id,title_es,title_en,version,effective_at,state_codes,approval_status").in("approval_status", ["approved", "published"]).limit(20),
      supabase.from("social_institutions").select("id,official_name,services,state_code,municipality,languages,cost_type,required_documents,capacity_status,status").neq("status", "archived").limit(20),
    ]);

    const safeRows = (label: string, res: any) => {
      if (res?.error) {
        console.warn(`[TalkToCareCase] Subsection warning (${label}):`, res.error.message);
        return [];
      }
      return res?.data ?? [];
    };
    const safeItem = (label: string, res: any) => {
      if (res?.error) {
        console.warn(`[TalkToCareCase] Item warning (${label}):`, res.error.message);
        return null;
      }
      return res?.data ?? null;
    };

    const x = {
      case: sc,
      person: safeItem("person", personRes),
      family: safeItem("family", familyRes),
      intakes: safeRows("intakes", intakesRes),
      assessments: safeRows("assessments", assessmentsRes),
      plans: safeRows("plans", plansRes),
      interventions: safeRows("interventions", interventionsRes),
      tasks: safeRows("tasks", tasksRes),
      referrals: safeRows("referrals", referralsRes),
      documents: safeRows("documents", documentsRes),
      consents: safeRows("consents", consentsRes),
      requirements: safeRows("requirements", requirementsRes),
      knowledge: safeRows("knowledge", knowledgeRes),
      resources: safeRows("resources", resourcesRes),
    };

    const health = buildCareHealth(x, data.language);
    const factSheet = buildFactSheet(x, health);
    const openTasks = x.tasks.filter((t: any) => !["completed", "cancelled", "done"].includes(t.status));
    const openReferrals = x.referrals.filter((v: any) => !["completed", "closed", "verified"].includes(v.status));

    let answerText: string;
    let providerUsed: string | null = null;

    if (data.healthCheck) {
      answerText = buildDeterministicAnswer(health, data.language);
    } else {
      try {
        const { routeAI } = await import("@/lib/ai/router.server");
        const sysPrompt = careAssistantSystem(data.language);
        const userPrompt = `HECHOS AUTORIZADOS DEL CASO:\n${JSON.stringify(factSheet, null, 2)}\n\nPREGUNTA DE LA PERSONA PROFESIONAL:\n${data.question}`;

        const aiRes = await routeAI({
          system: sysPrompt,
          prompt: userPrompt,
          userId,
          task: "social_case_narrative",
        });

        if (aiRes?.text && aiRes.text.trim().length > 0) {
          answerText = localizeAssistantLabels(aiRes.text, data.language);
          providerUsed = aiRes.provider || null;
        } else {
          answerText = buildDeterministicAnswer(health, data.language);
        }
      } catch (aiErr: any) {
        console.warn("[TalkToCareCase] AI routing fallback to deterministic answer:", aiErr?.message);
        answerText = buildDeterministicAnswer(health, data.language);
      }
    }

    const sources = [
      `Case ${sc.case_number}`,
      ...x.assessments.slice(0, 1).map((v: any) => `Assessment ${v.id} v${v.current_version}, ${v.assessment_date}`),
      ...x.plans.slice(0, 1).map((v: any) => `Care plan ${v.id} v${v.current_version}`),
      ...x.interventions.slice(0, 3).map((v: any) => `Intervention ${v.id}, ${v.occurred_at}`),
      ...x.referrals.slice(0, 3).map((v: any) => `Referral ${v.referral_number}, status ${v.status}`),
      ...x.knowledge.slice(0, 3).map((v: any) => `Knowledge Center: ${data.language === "es" ? v.title_es : v.title_en}, v${v.version}, effective ${v.effective_at ?? "not recorded"}`),
    ];

    const response = {
      answer: answerText,
      provider_used: providerUsed,
      current_case_status: {
        summary: `${sc.case_number}: ${sc.status}; risk ${sc.risk_level}. ${x.interventions.length} interventions, ${openTasks.length} open tasks, ${openReferrals.length} open referrals.`,
        last_activity: sc.last_activity_at,
      },
      missing_or_incomplete: [...health.critical, ...health.action_required, ...health.incomplete],
      risks_requiring_review: health.critical,
      recommended_next_steps: [...health.critical, ...health.action_required, ...health.incomplete].slice(0, 8).map((v: any) => ({
        action: v.message,
        responsible_role: v.code === "risk_review" ? "supervisor" : "case_manager",
        suggested_due_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        reason: v.code,
        supporting_record: v.source,
        consent_required: ["consent", "documents", "referrals"].includes(v.code),
      })),
      sources,
      health_check: health,
      resource_recommendations: x.resources.slice(0, 10).map((v: any) => ({
        ...v,
        warning: v.status !== "verified" ? "Resource verification must be reviewed" : null,
      })),
      professional_review_notice: "Indicators and proposed next steps require review by the responsible professional. No allegation or diagnosis is confirmed by this assistant.",
    };

    const manifest = {
      authenticated_user: userId,
      organization: sc.org_id,
      selected_case: data.caseId,
      case_assignment: sc.assigned_case_manager,
      record_types: ["general_case_record"],
      excluded: ["legal_privileged_record", "psychosocial_restricted_record", "medical_restricted_record", "child_protection_restricted_record"],
      language: data.language,
      retrieved_at: new Date().toISOString(),
    };

    const run = await supabase.from("social_care_assistant_runs").insert({
      org_id: sc.org_id,
      social_case_id: data.caseId,
      actor_id: userId,
      language: data.language,
      question: data.question,
      response,
      retrieval_manifest: manifest,
      health_check: data.healthCheck,
    }).select("id").single();
    fail(run.error);

    return { runId: run.data.id, response, manifest };
  });

export const proposeCareAssistantAction=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({caseId:uuid,runId:uuid.optional(),actionType:careActionType,title:z.string().trim().min(2).max(300),details:z.record(z.string(),z.unknown()).default({})}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const sc=await supabase.from("social_cases").select("org_id").eq("id",data.caseId).single();fail(sc.error);const preview={title:data.title,details:data.details,warning:"Confirmation is required. No material case state has changed."};const row=await supabase.from("social_care_action_proposals").insert({org_id:sc.data.org_id,social_case_id:data.caseId,assistant_run_id:data.runId??null,action_type:data.actionType,preview,proposed_by:userId}).select("id,status,preview").single();fail(row.error);return row.data;});

export const confirmCareAssistantAction=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({proposalId:uuid,confirm:z.literal(true)}).parse(d))
  .handler(async({data,context})=>{const {supabase,userId}=ctx(context);const row=await supabase.from("social_care_action_proposals").update({status:"confirmed",confirmed_by:userId,confirmed_at:new Date().toISOString()}).eq("id",data.proposalId).eq("status","proposed").select("id,status,action_type,preview").single();fail(row.error);return row.data;});


const organizationSeatRole=z.enum(["firm_manager","supervisor","case_worker","legal_provider","psychosocial_provider","read_only"]);

export const inviteSocialOrganizationMember=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid,email:z.string().trim().email(),name:z.string().trim().min(2).max(160),title:z.string().trim().min(2).max(160),role:organizationSeatRole}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:invitation,error}=await supabase.rpc("invite_social_organization_member",{
      p_org:data.orgId,p_email:data.email,p_role:data.role,p_name:data.name,p_title:data.title,
    });
    fail(error);
    const inv=invitation as Record<string,any>|null;

    // If this email already belongs to an account, activate that account now so
    // the manager can assign cases immediately. New accounts are activated by
    // getSocialWorkspace after they sign in with the invited email.
    let memberActivated=false;
    try{
      const invitationId=inv?.id;
      if(invitationId){
        const {data:activation,error:activationError}=await supabase.rpc(
          "activate_existing_social_invitee",
          {p_invitation:invitationId},
        );
        if(activationError) throw activationError;
        memberActivated=activation?.activated===true;
      }
    }catch(e){
      console.error("[inviteSocialOrganizationMember] existing-account activation failed",e);
    }

    // Email the invitee a clickable link so they can create their account.
    // Delivery problems never invalidate the recorded invitation.
    let emailSent=false;
    try{
      const token=inv?.token??inv?.invitation_token;
      if(token){
        const {data:orgRow}=await supabase.from("organizations").select("name").eq("id",data.orgId).maybeSingle();
        const {sendTemplateEmail}=await import("@/lib/email-templates/send-email");
        const res=await sendTemplateEmail("team-invite",data.email.toLowerCase(),{
          templateData:{
            firmName:orgRow?.name??"tu equipo",
            roleLabel:data.role,
            inviteEmail:data.email.toLowerCase(),
            signupUrl:`https://mexico.nyrava.com/social?invite=${encodeURIComponent(String(token))}`,
          },
          idempotencyKey:`org-invite-${data.orgId}-${data.email.toLowerCase()}`,
        });
        emailSent=res.sent;
      }
    }catch(e){console.error("[inviteSocialOrganizationMember] invite email failed",e);}
    return {...(inv??{}),emailSent,memberActivated};
  });

export const updateSocialOrganizationMember=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    orgId:uuid,userId:uuid,role:organizationSeatRole,
    status:z.enum(["active","suspended","removed"]),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:member,error}=await supabase.rpc("set_social_organization_member",{
      p_org:data.orgId,p_user:data.userId,p_role:data.role,p_status:data.status,
    });
    fail(error);return member;
  });

export const acceptSocialOrganizationInvitation=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({token:z.string().trim().min(32).max(200)}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:membership,error}=await supabase.rpc("accept_social_organization_invitation",{p_token:data.token});
    fail(error);return membership;
  });

const socialIntakeSource=z.enum(["direct","phone","email","walk_in","outreach","referral","emergency","other"]);
const socialIntakeDisposition=z.enum(["refer_only","information_only","ineligible","duplicate","no_follow_up"]);

export const getSocialIntakes=createServerFn({method:"GET"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({orgId:uuid}).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:rows,error}=await supabase.from("social_intakes")
      .select("id,org_id,program_id,intake_number,person_id,family_id,source,status,disposition,summary,presenting_needs,assigned_to,social_case_id,disposition_reason,created_at,completed_at")
      .eq("org_id",data.orgId)
      .order("created_at",{ascending:false})
      .limit(250);
    fail(error);return rows??[];
  });

export const createSocialIntake=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    orgId:uuid,programId:uuid,personId:uuid,familyId:uuid.optional(),
    source:socialIntakeSource.default("direct"),
    summary:z.string().trim().min(3).max(10000),
    presentingNeeds:z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    assignedUserId:uuid.optional(),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("create_social_intake",{
      p_org:data.orgId,p_program:data.programId,p_person:data.personId,
      p_family:data.familyId??null,p_source:data.source,p_summary:data.summary,
      p_presenting_needs:data.presentingNeeds,p_assigned_user:data.assignedUserId??null,
    });
    fail(error);return row;
  });

export const completeSocialIntake=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    intakeId:uuid,disposition:socialIntakeDisposition,
    reason:z.string().trim().min(3).max(5000),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("complete_social_intake",{
      p_intake:data.intakeId,p_disposition:data.disposition,p_reason:data.reason,
    });
    fail(error);return row;
  });

export const openCareCaseFromIntake=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    intakeId:uuid,
    caseType:z.enum(["individual","minor_child","family"]),
    priority:z.enum(["standard","urgent","emergency"]).default("standard"),
    assignedUserId:uuid.optional(),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("open_care_case_from_intake",{
      p_intake:data.intakeId,p_case_type:data.caseType,p_priority:data.priority,
      p_assigned_user:data.assignedUserId??null,
    });
    fail(error);return row;
  });

export const updateCareCaseState=createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator((d:unknown)=>z.object({
    caseId:uuid,
    status:z.enum(["intake","assessment","active","monitoring","pending_referral","reopened"]),
    priority:z.enum(["standard","urgent","emergency"]),
    reason:z.string().trim().min(5).max(2000),
  }).parse(d))
  .handler(async({data,context})=>{
    const {supabase}=ctx(context);
    const {data:row,error}=await supabase.rpc("update_care_case_state",{
      p_case:data.caseId,p_status:data.status,p_priority:data.priority,p_reason:data.reason,
    });
    fail(error);return row;
  });

export const getSocialCaseTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ orgId: uuid.optional(), category: z.string().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = ctx(context);
    const { MEXICO_TEMPLATES } = await import("@/lib/social/templates/mexico-template-definitions");
    let customTemplates: any[] = [];
    try {
      const q = supabase.from("social_case_templates").select("*").eq("active", true);
      if (data.orgId) q.or(`org_id.is.null,org_id.eq.${data.orgId}`);
      const res = await q;
      if (res.data) customTemplates = res.data;
    } catch {
      // fallback to built-in if table query fails
    }
    const combined = [...MEXICO_TEMPLATES, ...customTemplates];
    if (data.category) return combined.filter((t: any) => t.category === data.category);
    return combined;
  });

export const createCaseDocumentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    caseId: uuid,
    templateCode: z.string().trim().min(2).max(120),
    language: z.enum(["es", "en"]).default("es"),
    referralId: uuid.optional(),
    carePlanGoalId: uuid.optional(),
    recipientInfo: z.object({
      organization: z.string().optional(),
      contact_name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
    }).default({}),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const { findTemplateByCode } = await import("@/lib/social/templates/mexico-template-definitions");
    const { extractAuthorizedCaseContext, prefillTemplate } = await import("@/lib/social/templates/document-engine");

    const template = findTemplateByCode(data.templateCode);
    if (!template) throw new Error("Template not found: " + data.templateCode);

    const caseRow = await supabase.from("social_cases").select("id,org_id,case_number,priority,status,assigned_case_manager,person_id,family_id").eq("id", data.caseId).single();
    fail(caseRow.error);
    const sc = caseRow.data;

    const [person, family, assessments, carePlans, worker] = await Promise.all([
      sc.person_id ? supabase.from("social_people").select("id,legal_name,preferred_name,telephone,email,municipality,state,nationality,birth_date").eq("id", sc.person_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      sc.family_id ? supabase.from("social_families").select("id,family_name,primary_contact_person_id").eq("id", sc.family_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      supabase.from("social_assessments").select("id,risk_level,reason,protective_factors,assessment_date").eq("social_case_id", data.caseId).order("assessment_date", { ascending: false }).limit(1),
      supabase.from("social_care_plans").select("id,status,social_care_plan_versions(summary,social_care_plan_goals(goal,target_date))").eq("social_case_id", data.caseId).order("created_at", { ascending: false }).limit(1),
      sc.assigned_case_manager ? supabase.from("social_organization_members").select("name,email,title").eq("user_id", sc.assigned_case_manager).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);

    const contextMap = extractAuthorizedCaseContext({
      caseRecord: sc,
      person: person.data ? {
        id: person.data.id,
        legal_name: person.data.legal_name,
        preferred_name: person.data.preferred_name,
        phone: person.data.telephone,
        email: person.data.email,
        municipality: person.data.municipality,
        state: person.data.state,
        nationality: person.data.nationality,
        birth_date: person.data.birth_date,
      } : null,
      family: family.data ? { id: family.data.id, family_name: family.data.family_name } : null,
      riskAssessment: assessments.data?.[0] ?? null,
      carePlan: {
        goals: (carePlans.data?.[0]?.social_care_plan_versions?.[0]?.social_care_plan_goals ?? []) as any[],
        presenting_needs: carePlans.data?.[0]?.social_care_plan_versions?.[0]?.summary ?? undefined,
      },
      worker: worker.data ? { name: worker.data.name, contact: worker.data.title, email: worker.data.email } : null,
    });

    const prefilled = prefillTemplate(template, contextMap, data.language);
    const docTitle = `${data.language === "es" ? template.name_es : template.name_en} — ${sc.case_number}`;

    const insertRes = await supabase.from("social_documents").insert({
      org_id: sc.org_id,
      social_case_id: sc.id,
      person_id: sc.person_id,
      family_id: sc.family_id,
      title: docTitle,
      document_type: template.purpose || "referral",
      record_type: (template.record_type as any) || "general_case_record",
      sensitivity: "confidential",
      template_code: template.code,
      template_version: template.version,
      purpose: template.purpose,
      lifecycle_status: "draft",
      language_code: data.language,
      draft_payload: prefilled.values,
      recipient_info: data.recipientInfo,
      referral_id: data.referralId ?? null,
      care_plan_goal_id: data.carePlanGoalId ?? null,
      storage_path: `drafts/${sc.org_id}/${sc.id}/${crypto.randomUUID()}.json`,
      uploaded_by: userId,
    }).select("*").single();
    fail(insertRes.error);
    return insertRes.data;
  });

export const updateCaseDocumentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    documentId: uuid,
    title: z.string().trim().min(1).max(300).optional(),
    language: z.enum(["es", "en"]).optional(),
    draftPayload: z.record(z.string(), z.unknown()),
    recipientInfo: z.record(z.string(), z.unknown()).default({}),
    lifecycleStatus: z.enum(["draft", "ready_for_review"]).default("draft"),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = ctx(context);
    const updateRes = await supabase.from("social_documents").update({
      ...(data.title && { title: data.title }),
      ...(data.language && { language_code: data.language }),
      draft_payload: data.draftPayload,
      recipient_info: data.recipientInfo,
      lifecycle_status: data.lifecycleStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", data.documentId).select("*").single();
    fail(updateRes.error);
    return updateRes.data;
  });

export const finalizeCaseDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    documentId: uuid,
    draftPayload: z.record(z.string(), z.unknown()),
    recipientInfo: z.record(z.string(), z.unknown()).default({}),
    language: z.enum(["es", "en"]).default("es"),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const { findTemplateByCode } = await import("@/lib/social/templates/mexico-template-definitions");
    const { generateCaseDocumentPdf } = await import("@/lib/social/templates/document-engine");

    const docRow = await supabase.from("social_documents").select("*").eq("id", data.documentId).single();
    fail(docRow.error);
    const doc = docRow.data;

    const template = findTemplateByCode(doc.template_code || "mex_ficha_ingreso");
    if (!template) throw new Error("Template definition not found");

    const pdfBytes = generateCaseDocumentPdf(template, data.draftPayload, data.recipientInfo as any, data.language);
    const storagePath = `social-documents/${doc.org_id}/${doc.social_case_id}/${doc.id}-v1.pdf`;

    const uploadRes = await supabase.storage.from("social-case-files").upload(storagePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (uploadRes.error) throw uploadRes.error;

    const digest = await crypto.subtle.digest("SHA-256", pdfBytes.buffer as ArrayBuffer);
    const checksum = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");

    await supabase.from("social_document_versions").insert({
      org_id: doc.org_id,
      document_id: doc.id,
      version: 1,
      checksum,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdfBytes.byteLength,
      uploaded_by: userId,
      notes: data.language === "es" ? "Documento finalizado y aprobado por el profesional" : "Document finalized and approved by professional",
    });

    const updateRes = await supabase.from("social_documents").update({
      draft_payload: data.draftPayload,
      recipient_info: data.recipientInfo,
      language_code: data.language,
      lifecycle_status: "finalized",
      document_status: "active",
      storage_path: storagePath,
      checksum,
      mime_type: "application/pdf",
      size_bytes: pdfBytes.byteLength,
      finalized_at: new Date().toISOString(),
      finalized_by: userId,
      updated_at: new Date().toISOString(),
    }).eq("id", doc.id).select("*").single();
    fail(updateRes.error);
    return updateRes.data;
  });

export const sendCaseDocumentEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    documentId: uuid,
    toEmail: z.string().trim().email(),
    subject: z.string().trim().min(2).max(200),
    message: z.string().trim().min(5).max(4000),
    consentId: uuid,
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const docRow = await supabase.from("social_documents").select("*,social_cases(id,org_id,case_number,person_id,family_id)").eq("id", data.documentId).single();
    fail(docRow.error);
    const doc = docRow.data;
    const sc = doc.social_cases;

    const consentRow = await supabase.from("social_consents").select("*").eq("id", data.consentId).single();
    fail(consentRow.error);
    const consent = consentRow.data;

    if (consent.status !== "active" || (consent.expires_at && new Date(consent.expires_at) < new Date())) {
      throw new Error("El consentimiento seleccionado no está activo o ha expirado. Verifique la pestaña Consentimiento.");
    }

    const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");
    await sendTemplateEmail("resource-contact", data.toEmail, {
      idempotencyKey: crypto.randomUUID(),
      templateData: {
        subject: data.subject,
        message: data.message,
        caseReference: sc.case_number,
        documents: [doc.title],
      },
    });

    await supabase.from("social_document_shares").insert({
      org_id: sc.org_id,
      document_id: doc.id,
      receiving_org_id: sc.org_id,
      consent_id: consent.id,
      purpose: data.subject,
      shared_by: userId,
    });

    await supabase.from("social_tasks").insert({
      org_id: sc.org_id,
      social_case_id: sc.id,
      title: `Seguimiento de envío: ${doc.title}`,
      description: `Documento enviado a ${data.toEmail}. Asunto: ${data.subject}`,
      priority: "normal",
      status: "todo",
      due_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });

    if (doc.referral_id) {
      await supabase.from("social_referrals").update({
        status: "sent",
        updated_at: new Date().toISOString(),
      }).eq("id", doc.referral_id);
    }

    const updated = await supabase.from("social_documents").update({
      lifecycle_status: "sent",
      sent_at: new Date().toISOString(),
      sent_to: data.toEmail,
      disclosure_check: {
        consent_id: consent.id,
        consent_type: consent.consent_type,
        verified_at: new Date().toISOString(),
        recipient: data.toEmail,
      },
    }).eq("id", doc.id).select("*").single();
    fail(updated.error);
    return updated.data;
  });

export const getSocialActivityRecordDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: uuid, activityId: uuid }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);

    // Fetch the activity event
    const eventRes = await supabase.from("social_activity_events").select("*").eq("id", data.activityId).eq("social_case_id", data.caseId).single();
    fail(eventRes.error);
    const event = eventRes.data;

    let record: any = null;
    let actorName: string | null = null;
    let permittedActions = {
      canEdit: false,
      canDelete: false,
      canAddFollowUp: false,
      canCreateNewVersion: false,
      isReadOnly: true,
      targetTab: "activity",
    };

    if (event.actor_id) {
      const member = await supabase.from("social_organization_members").select("name,email").eq("user_id", event.actor_id).maybeSingle();
      if (member.data) actorName = member.data.name || member.data.email;
    }

    const entityType = event.entity_type;
    const entityId = event.entity_id;

    if (!entityId) {
      return { event, record: null, actorName, permittedActions };
    }

    switch (entityType) {
      case "social_interventions": {
        const res = await supabase.from("social_interventions").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: true,
          canAddFollowUp: true,
          canCreateNewVersion: false,
          isReadOnly: false,
          targetTab: "interventions",
        };
        break;
      }
      case "social_care_plans": {
        const res = await supabase.from("social_care_plans").select("*,social_care_plan_versions(*,social_care_plan_goals(*))").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: true,
          canCreateNewVersion: true,
          isReadOnly: true,
          targetTab: "plan",
        };
        break;
      }
      case "social_assessments": {
        const res = await supabase.from("social_assessments").select("*,social_assessment_versions(*)").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: true,
          isReadOnly: true,
          targetTab: "risk",
        };
        break;
      }
      case "social_documents": {
        const res = await supabase.from("social_documents").select("*,social_document_versions(*)").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: record?.lifecycle_status === "draft",
          canDelete: record?.lifecycle_status === "draft",
          canAddFollowUp: false,
          canCreateNewVersion: true,
          isReadOnly: record?.lifecycle_status === "finalized" || record?.lifecycle_status === "sent",
          targetTab: "documents",
        };
        break;
      }
      case "social_alerts": {
        const res = await supabase.from("social_alerts").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: false,
          canAddFollowUp: true,
          canCreateNewVersion: false,
          isReadOnly: false,
          targetTab: "tasks",
        };
        break;
      }
      case "social_tasks": {
        const res = await supabase.from("social_tasks").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: true,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: false,
          targetTab: "tasks",
        };
        break;
      }
      case "social_document_access_events": {
        const res = await supabase.from("social_document_access_events").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: true,
          targetTab: "documents",
        };
        break;
      }
      case "social_cases": {
        const res = await supabase.from("social_cases").select("id,case_number,status,priority,risk_level,last_activity_at,assigned_case_manager").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: true,
          targetTab: "summary",
        };
        break;
      }
      case "social_consents": {
        const res = await supabase.from("social_consents").select("*,social_consent_versions(*)").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: true,
          isReadOnly: true,
          targetTab: "consent",
        };
        break;
      }
      case "social_referrals": {
        const res = await supabase.from("social_referrals").select("*,social_referral_updates(*)").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: false,
          canAddFollowUp: true,
          canCreateNewVersion: false,
          isReadOnly: false,
          targetTab: "referral",
        };
        break;
      }
      case "social_appointments": {
        const res = await supabase.from("social_appointments").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: true,
          canDelete: true,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: false,
          targetTab: "tasks",
        };
        break;
      }
      case "social_case_closures": {
        const res = await supabase.from("social_case_closures").select("*").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: true,
          targetTab: "closure",
        };
        break;
      }
      case "social_case_transfers": {
        const res = await supabase.from("social_case_transfers").select("*,social_case_transfer_items(*)").eq("id", entityId).maybeSingle();
        record = res.data;
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: true,
          targetTab: "transfer",
        };
        break;
      }
      default: {
        permittedActions = {
          canEdit: false,
          canDelete: false,
          canAddFollowUp: false,
          canCreateNewVersion: false,
          isReadOnly: true,
          targetTab: "activity",
        };
        break;
      }
    }

    return { event, record, actorName, permittedActions };
  });

export const updateSocialIntervention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    interventionId: uuid,
    reason: z.string().trim().min(2).max(4000),
    actionsTaken: z.string().trim().min(2).max(4000),
    outcome: z.string().trim().max(4000).optional(),
    followUpRequired: z.boolean().default(false),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const existing = await supabase.from("social_interventions").select("*").eq("id", data.interventionId).single();
    fail(existing.error);

    const updateRes = await supabase.from("social_interventions").update({
      reason: data.reason,
      actions_taken: data.actionsTaken,
      outcome: data.outcome ?? null,
      follow_up_required: data.followUpRequired,
      updated_at: new Date().toISOString(),
    }).eq("id", data.interventionId).select("*").single();
    fail(updateRes.error);

    // Explicitly record update in social_activity_events
    await supabase.from("social_activity_events").insert({
      org_id: existing.data.org_id,
      social_case_id: existing.data.social_case_id,
      actor_id: userId,
      event_type: "update",
      entity_type: "social_interventions",
      entity_id: data.interventionId,
      metadata: { operation: "UPDATE", service_type: existing.data.service_type },
    });

    return updateRes.data;
  });

export const deleteSocialIntervention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    interventionId: uuid,
    reason: z.string().trim().min(2).max(1000),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = ctx(context);
    const existing = await supabase.from("social_interventions").select("*").eq("id", data.interventionId).single();
    fail(existing.error);

    const deleteRes = await supabase.from("social_interventions").delete().eq("id", data.interventionId);
    fail(deleteRes.error);

    // Explicitly record deletion event in immutable ledger
    await supabase.from("social_activity_events").insert({
      org_id: existing.data.org_id,
      social_case_id: existing.data.social_case_id,
      actor_id: userId,
      event_type: "delete",
      entity_type: "social_interventions",
      entity_id: data.interventionId,
      metadata: { operation: "DELETE", service_type: existing.data.service_type, deletion_reason: data.reason },
    });

    return { ok: true };
  });


