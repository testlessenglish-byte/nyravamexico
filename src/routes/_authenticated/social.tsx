import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, ArrowRight, BriefcaseMedical, CalendarClock,
  CheckCircle2, ClipboardCheck, FileHeart, FileText, HeartHandshake,
  Loader2, Search, ShieldCheck, UserPlus, Users,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { useRoles } from "@/hooks/use-roles";
import {
  acceptSocialOrganizationInvitation, acknowledgeSocialAlert, createAndAssignCareCase, createSocialFamily, createSocialPerson,
  findPossibleSocialPeople, ensureSocialProgram, getSocialIndicators,
  getSocialWorkspace, searchSocialRecords,
} from "@/lib/social.functions";
import { EMERGENCY_GUIDANCE } from "@/lib/social/types";
import { SocialCaseWorkspace } from "@/components/social/SocialCaseWorkspace";
import { SocialDocumentsHub } from "@/components/social/SocialDocumentsHub";
import { ResourceKnowledgeNetwork } from "@/components/social/ResourceKnowledgeNetwork";
import { KnowledgeCenter } from "@/components/social/KnowledgeCenter";
import { EscapedTextNormalizer } from "@/components/social/EscapedTextNormalizer";
import { SocialIntakeManager } from "@/components/social/SocialIntakeManager";
import { NyravaPagination } from "@/components/common/NyravaPagination";
import { formatActivityDescription } from "@/lib/social/activity-label-normalizer";
import { getTeamActivityEventsPaginated } from "@/lib/social.functions";
import { CaseActivityDrawerModal } from "@/components/social/CaseActivityDrawerModal";

export const Route=createFileRoute("/_authenticated/social")({
  validateSearch: (search: Record<string, unknown>): {
    area?: Area;
    caseId?: string;
    tab?: string;
    orgId?: string;
    invite?: string;
  } => {
    return {
      area: typeof search.area === "string" ? (search.area as Area) : undefined,
      caseId: typeof search.caseId === "string" ? search.caseId : undefined,
      tab: typeof search.tab === "string" ? search.tab : undefined,
      orgId: typeof search.orgId === "string" ? search.orgId : undefined,
      invite: typeof search.invite === "string" ? search.invite : undefined,
    };
  },
  head:()=>({meta:[
    {title:"Atención Integral — Nyrava México"},
    {name:"description",content:"Gestión social integral, separada de los expedientes jurídicos migratorios."},
  ]}),
  component:SocialCarePage,
});

type Area="dashboard"|"cases"|"caseWork"|"intake"|"assessments"|"plans"|"interventions"|"legal"|"psychosocial"|"referrals"|"resources"|"knowledge"|"resourceAdmin"|"tasks"|"documents"|"transfers"|"closure"|"indicators"|"activity"|"administration";
const PRIMARY_AREAS:Array<{id:Area;es:string;en:string;icon:typeof Activity}>=[
  {id:"dashboard",es:"Resumen",en:"Overview",icon:Activity},
  {id:"cases",es:"Casos",en:"Cases",icon:FileHeart},
  {id:"caseWork",es:"Trabajo del caso",en:"Case Work",icon:BriefcaseMedical},
  {id:"tasks",es:"Tareas y alertas",en:"Tasks and Alerts",icon:CalendarClock},
  {id:"documents",es:"Documentos y consentimiento",en:"Documents and Consent",icon:FileText},
  {id:"activity",es:"Actividad del equipo",en:"Team Activity",icon:Users},
  {id:"administration",es:"Configuración de la organización",en:"Organization Settings",icon:ShieldCheck},
];
const CONTEXT_AREAS:Array<{id:Area;es:string;en:string;icon:typeof Activity}>=[
  {id:"intake",es:"Gestión de ingresos",en:"Intake Management",icon:UserPlus},
  {id:"resources",es:"Red de Recursos",en:"Resource Network",icon:Search},
  {id:"knowledge",es:"Centro de Conocimiento",en:"Knowledge Center",icon:FileText},
  {id:"indicators",es:"Indicadores institucionales",en:"Institutional Indicators",icon:Activity},
];
// Resource & Knowledge Administration is not part of normal Comprehensive Care
// navigation. It is surfaced only to Nyrava/platform administrators and
// authorized organization managers.
const ADMIN_AREA:{id:Area;es:string;en:string;icon:typeof Activity}={id:"resourceAdmin",es:"Administración de recursos y conocimiento",en:"Resource & Knowledge Administration",icon:ShieldCheck};

function errorMessage(error:unknown):string{
  if(error instanceof Error&&error.message){
    try{
      const issues=JSON.parse(error.message);
      if(Array.isArray(issues)&&typeof issues[0]?.message==="string")return issues[0].message;
    }catch{/* The message is not a serialized validation issue. */}
    return error.message;
  }
  if(error&&typeof error==="object"){
    const candidate=error as {message?:unknown;data?:{message?:unknown};cause?:unknown};
    if(typeof candidate.message==="string"&&candidate.message)return candidate.message;
    if(typeof candidate.data?.message==="string"&&candidate.data.message)return candidate.data.message;
    if(candidate.cause)return errorMessage(candidate.cause);
  }
  return typeof error==="string"?error:"The Social operation could not be completed";
}

function SocialCarePage(){
  const {locale}=useI18n(); const es=locale==="es"; const qc=useQueryClient();
  const searchParams=Route.useSearch();
  const navigate=useNavigate();
  const workspaceFn=useServerFn(getSocialWorkspace);
  const createPersonFn=useServerFn(createSocialPerson);
  const createCaseFn=useServerFn(createAndAssignCareCase);
  const duplicateFn=useServerFn(findPossibleSocialPeople);
  const searchFn=useServerFn(searchSocialRecords);
  const ensureProgramFn=useServerFn(ensureSocialProgram);
  const createFamilyFn=useServerFn(createSocialFamily);
  const indicatorsFn=useServerFn(getSocialIndicators);
  const acknowledgeAlertFn=useServerFn(acknowledgeSocialAlert);
  const acceptInvitationFn=useServerFn(acceptSocialOrganizationInvitation);
  
  const area:Area=searchParams.area||"dashboard";
  const selectedCaseId=searchParams.caseId||"";
  const activeCaseTab=searchParams.tab||"overview";
  const orgId=searchParams.orgId||"";

  const setArea=(newArea:Area)=>{
    void navigate({
      to: "/social",
      search: {
        area: newArea==="dashboard"?undefined:newArea,
        caseId: undefined,
        tab: undefined,
        orgId: orgId||undefined,
      },
      replace: true,
    } as any);
  };

  const setSelectedCaseId=(id:string,initialTab?:string)=>{
    void navigate({
      to: "/social",
      search: {
        area: area==="dashboard"?undefined:area,
        caseId: id||undefined,
        tab: id?(initialTab||activeCaseTab||"overview"):undefined,
        orgId: orgId||undefined,
      },
      replace: true,
    } as any);
  };

  const handleCaseTabChange=(nextTab:string)=>{
    void navigate({
      to: "/social",
      search: {
        area: area==="dashboard"?undefined:area,
        caseId: selectedCaseId||undefined,
        tab: nextTab==="overview"?undefined:nextTab,
        orgId: orgId||undefined,
      },
      replace: true,
    } as any);
  };

  const setOrgId=(newOrgId:string)=>{
    void navigate({
      to: "/social",
      search: {
        area: area==="dashboard"?undefined:area,
        caseId: selectedCaseId||undefined,
        tab: activeCaseTab==="overview"?undefined:activeCaseTab,
        orgId: newOrgId||undefined,
      },
      replace: true,
    } as any);
  };
  const [query,setQuery]=useState("");
  const [caseListQuery,setCaseListQuery]=useState("");
  const [casePage,setCasePage]=useState(1);
  const [programSetup,setProgramSetup]=useState({nameEs:"Atención Integral",nameEn:"Comprehensive Care",prefix:"NYR-SOC"});
  const [family,setFamily]=useState({name:"",primaryId:"",memberIds:[] as string[]});
  const today=new Date().toISOString().slice(0,10);const yearStart=`${today.slice(0,4)}-01-01`;
  const [indicatorRange,setIndicatorRange]=useState({from:yearStart,to:today});
  const [acceptedInvite,setAcceptedInvite]=useState("");
  const [caseModalOpen,setCaseModalOpen]=useState(false);
  const workspace=useQuery({
    queryKey:["social-workspace"],
    queryFn:()=>workspaceFn(),
    refetchOnWindowFocus:true,
  });
  const allOrganizations=workspace.data?.organizations??[];
  const allOrganizationAccounts=workspace.data?.organizationAccounts??[];
  const currentUserId=workspace.data?.userId??"";
  const availableOrganizations=allOrganizations;
  const storedOrg=typeof window!=="undefined"?localStorage.getItem("nyrava:current_social_org"):null;
  const orgWithCases=availableOrganizations.find((o:any)=>(workspace.data?.cases??[]).some((c:any)=>c.org_id===o.id))?.id;
  const requestedOrg=(orgId&&availableOrganizations.some((organization:any)=>organization.id===orgId)&&orgId)
    || (storedOrg&&availableOrganizations.some((organization:any)=>organization.id===storedOrg)&&storedOrg)
    || orgWithCases
    || availableOrganizations[0]?.id
    || "";
  const resolvedOrg=requestedOrg;
  const organizationAccount=allOrganizationAccounts.find((x:any)=>x.orgId===resolvedOrg);
  const organizationMembers=organizationAccount?.members??[];
  const canManageOrganization=organizationAccount?.can_manage===true;
  const {isAdmin:isPlatformAdmin}=useRoles();
  const canAdministerResources=isPlatformAdmin||canManageOrganization;
  const navigationAreas=canManageOrganization
    ? PRIMARY_AREAS
    : PRIMARY_AREAS.filter((item)=>["dashboard","cases","caseWork","tasks","documents"].includes(item.id));
  const effectiveArea:Area=area==="resourceAdmin"&&!canAdministerResources?"resources":area;
  const programs=(workspace.data?.programs??[]).filter((p:any)=>p.org_id===resolvedOrg);
  const visibleCases=(workspace.data?.cases??[]).filter((c:any)=>c.org_id===resolvedOrg);
  const visiblePeople=(workspace.data?.people??[]).filter((p:any)=>p.org_id===resolvedOrg);
  const visibleFamilies=(workspace.data?.families??[]).filter((x:any)=>x.org_id===resolvedOrg);
  const visibleAlerts=(workspace.data?.alerts??[]).filter((x:any)=>x.org_id===resolvedOrg);
  const orgTasks=(workspace.data?.tasks??[]).filter((t:any)=>t.org_id===resolvedOrg);
  const orgReferrals=(workspace.data?.referrals??[]).filter((r:any)=>r.org_id===resolvedOrg);
  const now=Date.now();
  const orgActiveCases=visibleCases.filter((c:any)=>!["closed","archived","transferred"].includes(c.status)).length;
  const orgCriticalRisk=visibleAlerts.filter((a:any)=>a.severity==="critical"&&!a.acknowledged_at).length;
  const orgOverdueTasks=orgTasks.filter((t:any)=>t.due_at&&new Date(t.due_at).getTime()<now&&t.status!=="done").length;
  const orgUnverifiedReferrals=orgReferrals.filter((r:any)=>r.status!=="completed").length;
  const emergencyAlerts=visibleAlerts.filter((alert:any)=>
    alert.severity==="critical"
    && !alert.acknowledged_at
    && (canManageOrganization||alert.assigned_to===currentUserId)
  );
  const search=useMutation({
    mutationFn:()=>searchFn({data:{orgId:resolvedOrg,query,limit:50}}),
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const [person,setPerson]=useState({legalName:"",preferredName:"",telephone:"",email:"",nationality:""});
  const [caseDraft,setCaseDraft]=useState({
    programId:"",personId:"",newClientName:"",familyId:"",assignedUserId:"",
    caseType:"individual" as "individual"|"minor_child"|"family",
    priority:"standard" as "standard"|"urgent"|"emergency",
  });
  const duplicates=useMutation({
    mutationFn:()=>duplicateFn({data:{orgId:resolvedOrg,name:person.legalName,phone:person.telephone||undefined,email:person.email||undefined,limit:10}}),
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const createPersonMutation=useMutation({
    mutationFn:()=>createPersonFn({data:{orgId:resolvedOrg,legalName:person.legalName,preferredName:person.preferredName||undefined,telephone:person.telephone||undefined,email:person.email||undefined,nationality:person.nationality||undefined,aliases:[],languages:[],currentLocation:{},immigrationIdentifiers:{},unaccompaniedMinor:false,separatedMinor:false}}),
    onSuccess:(row:any)=>{toast.success(es?`Persona ${row.person_number} registrada`:`Person ${row.person_number} registered`);setPerson({legalName:"",preferredName:"",telephone:"",email:"",nationality:""});qc.invalidateQueries({queryKey:["social-workspace"]});},
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const createCaseMutation=useMutation({
    mutationFn:()=>createCaseFn({data:{
      orgId:resolvedOrg,programId:caseDraft.programId||programs[0]?.id,
      personId:caseDraft.personId||undefined,newClientName:caseDraft.personId?undefined:caseDraft.newClientName,
      familyId:caseDraft.familyId||undefined,assignedUserId:caseDraft.assignedUserId||undefined,
      caseType:caseDraft.caseType,priority:caseDraft.priority,
    }}),
    onSuccess:(row:any)=>{
      toast.success(es?`Caso ${row.case_number} abierto y asignado`:`Case ${row.case_number} opened and assigned`);
      setCaseModalOpen(false);setCaseDraft({...caseDraft,personId:"",newClientName:"",familyId:"",assignedUserId:"",priority:"standard"});
      void qc.invalidateQueries({queryKey:["social-workspace"]});setSelectedCaseId(row.id);
    },
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const programMutation=useMutation({
    mutationFn:()=>ensureProgramFn({data:{orgId:resolvedOrg,...programSetup}}),
    onSuccess:()=>{toast.success(es?"Programa social actualizado":"Social program updated");qc.invalidateQueries({queryKey:["social-workspace"]});},
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const familyMutation=useMutation({
    mutationFn:()=>createFamilyFn({data:{orgId:resolvedOrg,familyName:family.name,primaryContactPersonId:family.primaryId||undefined,currentLocation:{},memberIds:family.memberIds}}),
    onSuccess:()=>{toast.success(es?"Familia registrada":"Family registered");setFamily({name:"",primaryId:"",memberIds:[]});qc.invalidateQueries({queryKey:["social-workspace"]});},
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const indicators=useQuery({queryKey:["social-indicators",resolvedOrg,indicatorRange],queryFn:()=>indicatorsFn({data:{orgId:resolvedOrg,from:indicatorRange.from,to:indicatorRange.to}}),enabled:area==="indicators"&&!!resolvedOrg});
  const acknowledgeMutation=useMutation({
    mutationFn:(id:string)=>acknowledgeAlertFn({data:{alertId:id,resolve:true}}),
    onSuccess:()=>{toast.success(es?"Alerta resuelta":"Alert resolved");qc.invalidateQueries({queryKey:["social-workspace"]});},
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  const acceptInvitationMutation=useMutation({
    mutationFn:(token:string)=>acceptInvitationFn({data:{token}}),
    onSuccess:()=>{toast.success(es?"Se unió a la organización":"You joined the organization");void qc.invalidateQueries({queryKey:["social-workspace"]});window.history.replaceState({},document.title,"/social");},
    onError:(e:unknown)=>toast.error(errorMessage(e)),
  });
  useEffect(()=>{
    const token=new URLSearchParams(window.location.search).get("invite");
    if(token&&token!==acceptedInvite&&!acceptInvitationMutation.isPending){
      setAcceptedInvite(token);acceptInvitationMutation.mutate(token);
    }
  },[acceptedInvite]);
  useEffect(()=>{
    if(!canManageOrganization&&["activity","administration"].includes(area)){
      setArea("dashboard");
    }
  },[area,canManageOrganization]);
  const stats=workspace.data?.stats;
  const filtered=useMemo(()=>{
    const q=query.trim().toLocaleLowerCase("es-MX"); if(!q)return visibleCases;
    return visibleCases.filter((c:any)=>[c.case_number,c.case_type,c.status,c.risk_level].some(v=>String(v??"").toLocaleLowerCase("es-MX").includes(q)));
  },[visibleCases,query]);
  const dashboardCases=useMemo(()=>{
    const q=caseListQuery.trim().toLocaleLowerCase("es-MX");
    if(!q)return visibleCases;
    return visibleCases.filter((caseRow:any)=>{
      const person=visiblePeople.find((row:any)=>row.id===caseRow.person_id);
      const familyRow=visibleFamilies.find((row:any)=>row.id===caseRow.family_id);
      return [
        caseRow.case_number,caseRow.case_type,caseRow.status,caseRow.risk_level,
        person?.legal_name,person?.preferred_name,familyRow?.family_name,
      ].some(value=>String(value??"").toLocaleLowerCase("es-MX").includes(q));
    });
  },[visibleCases,visiblePeople,visibleFamilies,caseListQuery]);
  const casePageCount=Math.max(1,Math.ceil(dashboardCases.length/10));
  const safeCasePage=Math.min(casePage,casePageCount);
  const dashboardCasePage=dashboardCases.slice((safeCasePage-1)*10,safeCasePage*10);
  useEffect(()=>setCasePage(1),[caseListQuery,resolvedOrg]);

  if(workspace.isLoading)return <div className="p-8 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{es?"Cargando Atención Integral…":"Loading Comprehensive Care…"}</div>;
  if(workspace.isError)return <div data-social-care-root className="mx-auto max-w-[1500px] p-4 md:p-6"><div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 text-destructive"/><div><h2 className="font-semibold text-destructive">{es?"Error al cargar Atención Integral":"Error loading Comprehensive Care"}</h2><p className="mt-1 text-sm text-muted-foreground">{errorMessage(workspace.error)}</p><button onClick={()=>workspace.refetch()} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90">{es?"Reintentar":"Retry"}</button></div></div></div></div>;
  if(selectedCaseId)return <div data-social-care-root className="mx-auto max-w-[1600px] p-4 md:p-6"><EscapedTextNormalizer/><SocialCaseWorkspace
    caseId={selectedCaseId}
    initialTab={activeCaseTab as any}
    onTabChange={handleCaseTabChange}
    people={workspace.data?.people??[]}
    institutions={workspace.data?.institutions??[]}
    templates={workspace.data?.templates??[]}
    roleAssignments={workspace.data?.roleAssignments??[]}
    organizationMembers={organizationMembers}
    currentUserId={currentUserId}
    onClose={()=>{setSelectedCaseId("");void qc.invalidateQueries({queryKey:["social-workspace"]});}}
  /></div>;
  return <div data-social-care-root className="mx-auto max-w-[1500px] p-4 md:p-6"><EscapedTextNormalizer/>
    <header className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/10 via-card to-accent/10 p-5 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div className="rounded-xl bg-primary/15 p-3 text-primary"><HeartHandshake className="h-6 w-6"/></div>
          <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-primary">Nyrava México</p>
            <h1 className="text-2xl font-semibold">{es?"Atención Integral y Gestión Social":"Comprehensive Care and Social Case Management"}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{es?"Área independiente de Derecho Migratorio, Refugio y Nacionalidad. Los vínculos jurídicos requieren autorización y consentimiento explícitos.":"A separate practice area from Immigration, Refugee and Nationality Law. Legal links require explicit authorization and consent."}</p>
          </div>
        </div>
        <label className="min-w-[180px] text-xs font-medium text-muted-foreground">
          {es?"Organización":"Organization"}
          <select aria-label={es?"Organización activa":"Active organization"} value={resolvedOrg} onChange={e=>{setOrgId(e.target.value);if(typeof window!=="undefined")localStorage.setItem("nyrava:current_social_org",e.target.value);}} disabled={!availableOrganizations.length} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground disabled:opacity-60">
            {!availableOrganizations.length&&<option value="">{es?"Sin organización":"No organization"}</option>}
            {availableOrganizations.map((o:any)=><option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      </div>
    </header>

    {!availableOrganizations.length&&<section className="mt-5 rounded-xl border border-warning/40 bg-warning/10 p-5">
      <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 text-warning"/><div><h2 className="font-semibold">{es?"La organización aún no está disponible":"Organization is not available yet"}</h2><p className="mt-1 text-sm text-muted-foreground">{es?"La suscripción y el perfil deben crear la organización automáticamente. Actualice la página; si continúa, un administrador debe revisar el evento de aprovisionamiento.":"Subscription and profile completion create the organization automatically. Refresh the page; if this remains, an administrator should inspect the provisioning event."}</p></div></div>
    </section>}

    {canManageOrganization&&<OpenAndAssignCaseModal open={caseModalOpen} es={es} draft={caseDraft} setDraft={setCaseDraft}
      programs={programs} people={visiblePeople} families={visibleFamilies} members={organizationMembers}
      currentUserId={workspace.data?.userId??""} pending={createCaseMutation.isPending}
      onClose={()=>setCaseModalOpen(false)} onSubmit={()=>createCaseMutation.mutate()}/>} 
    <div className="mt-5 grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="h-fit rounded-xl border border-border bg-card p-2 lg:sticky lg:top-4">
        <nav aria-label={es?"Navegación de Atención Integral":"Comprehensive Care navigation"} className="max-h-[72vh] space-y-1 overflow-y-auto">
          {navigationAreas.map(a=>{const Icon=a.icon;return <button key={a.id} onClick={()=>setArea(a.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${area===a.id?"bg-primary text-primary-foreground":"hover:bg-muted"}`}><Icon className="h-4 w-4"/>{es?a.es:a.en}</button>})}
          <details className="border-t border-border pt-2">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{es?"Herramientas y recursos":"Tools and resources"}</summary>
            <div className="mt-1 space-y-1">{[...CONTEXT_AREAS,...(canAdministerResources?[ADMIN_AREA]:[])].map(a=>{const Icon=a.icon;return <button key={a.id} onClick={()=>setArea(a.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${area===a.id?"bg-primary text-primary-foreground":"hover:bg-muted"}`}><Icon className="h-4 w-4"/>{es?a.es:a.en}</button>})}</div>
          </details>
        </nav>
      </aside>

      <main className="min-w-0">
        {area==="dashboard"&&<>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label={es?"Casos activos":"Active cases"} value={orgActiveCases}/>
            <Metric label={es?"Riesgo crítico":"Critical risk"} value={orgCriticalRisk} danger/>
            <Metric label={es?"Tareas vencidas":"Overdue tasks"} value={orgOverdueTasks}/>
            <Metric label={es?"Canalizaciones sin verificar":"Unverified referrals"} value={orgUnverifiedReferrals}/>
          </div>
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-4">
            <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 text-warning"/><div><p className="text-sm font-semibold">{es?"Guía de escalamiento":"Escalation guidance"}</p><p className="text-sm text-muted-foreground">{EMERGENCY_GUIDANCE[locale]}</p></div></div>
          </div>
          {emergencyAlerts.map((alert:any)=><div key={alert.id} className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 text-destructive"/><div><p className="text-sm font-semibold text-destructive">{es?alert.title_es:alert.title_en}</p><p className="text-xs text-muted-foreground">{es?"Caso de emergencia asignado. Requiere atención y acuse inmediato.":"Assigned emergency case. Immediate attention and acknowledgement are required."}</p></div></div>
            <div className="flex gap-2"><button type="button" onClick={()=>setSelectedCaseId(alert.social_case_id)} className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground">{es?"Abrir caso":"Open case"}</button><button type="button" disabled={acknowledgeMutation.isPending} onClick={()=>acknowledgeMutation.mutate(alert.id)} className="rounded-lg border border-destructive/30 px-3 py-2 text-xs font-semibold">{es?"Acusar recibo":"Acknowledge"}</button></div>
          </div>)}
          {canManageOrganization&&!visibleCases.length&&<div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><div><p className="text-sm font-semibold">{es?"Registre su primer caso":"Register your first case"}</p><p className="text-xs text-muted-foreground">{es?"Registre o seleccione al cliente, defina el tipo y asigne al responsable en un solo flujo.":"Register or select the client, choose the case type, and assign responsibility in one workflow."}</p></div><button type="button" onClick={()=>setCaseModalOpen(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">{es?"Registrar nuevo caso":"Register New Case"}</button></div>}
          <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
            <div><h2 className="text-base font-semibold">{canManageOrganization?(es?"Casos de la organización":"Organization cases"):(es?"Casos asignados":"Assigned cases")}</h2><p className="text-xs text-muted-foreground">{es?`${dashboardCases.length} casos autorizados`:`${dashboardCases.length} authorized cases`}</p></div>
            <label className="min-w-[260px] text-xs font-medium text-muted-foreground">{es?"Buscar por nombre o folio":"Search by name or case number"}<input value={caseListQuery} onChange={event=>setCaseListQuery(event.target.value)} placeholder={es?"Nombre o NYR-SOC-…":"Name or NYR-SOC-…"} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"/></label>
          </div>
          <CaseTable cases={dashboardCasePage} members={organizationMembers} es={es} onOpen={setSelectedCaseId}/>
          {dashboardCases.length>10&&<div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-sm"><span>{es?`Página ${safeCasePage} de ${casePageCount}`:`Page ${safeCasePage} of ${casePageCount}`}</span><div className="flex gap-2"><button type="button" disabled={safeCasePage<=1} onClick={()=>setCasePage(page=>Math.max(1,page-1))} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">{es?"Anterior":"Previous"}</button><button type="button" disabled={safeCasePage>=casePageCount} onClick={()=>setCasePage(page=>Math.min(casePageCount,page+1))} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">{es?"Siguiente":"Next"}</button></div></div>}
        </>}

        {area==="caseWork"&&<section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5">
            <div><h2 className="font-semibold">{es?"Trabajo del caso":"Case Work"}</h2><p className="mt-1 text-sm text-muted-foreground">{es?"Abra un caso autorizado para trabajar ingreso, riesgo, plan, intervenciones, servicios, canalizaciones, documentos, actividad y cierre con el mismo expediente.":"Open an authorized case to work intake, risk, care plan, interventions, services, referrals, documents, activity, and closure in one continuous record."}</p></div>
            {canManageOrganization&&<button type="button" onClick={()=>setCaseModalOpen(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">{es?"Registrar nuevo caso":"Register New Case"}</button>}
          </div>
          <CaseTable cases={visibleCases} members={organizationMembers} es={es} onOpen={setSelectedCaseId}/>
        </section>}

        {area==="cases"&&<section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
            <div><h2 className="font-semibold">{es?"Casos de Atención Integral":"Comprehensive Care cases"}</h2><p className="text-xs text-muted-foreground">{es?"Cada caso se abre y asigna mediante una sola transacción auditable.":"Every case is opened and assigned through one auditable transaction."}</p></div>
            {canManageOrganization&&<button type="button" onClick={()=>setCaseModalOpen(true)} disabled={!resolvedOrg||!programs.length} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{es?"Registrar nuevo caso":"Register New Case"}</button>}
          </div>
          <div className="mb-4 flex flex-wrap gap-2"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={es?"Buscar por nombre, folio, teléfono, estado…":"Search name, ID, phone, status…"} className="min-w-[260px] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"/><button onClick={()=>search.mutate()} disabled={!resolvedOrg||search.isPending} className="rounded-lg border border-border px-4 py-2 text-sm"><Search className="mr-2 inline h-4 w-4"/>{es?"Búsqueda amplia":"Broad search"}</button></div>
          {search.data&&<div className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">{es?"Resultados autorizados":"Authorized results"}: {search.data.length}</div>}
          <CaseTable cases={filtered} members={organizationMembers} es={es} onOpen={setSelectedCaseId}/>
        </section>}

        {area==="intake"&&<SocialIntakeManager orgId={resolvedOrg} programs={programs} people={visiblePeople} families={visibleFamilies} members={organizationMembers} onCaseOpened={setSelectedCaseId}/>}
        {area==="assessments"&&<OperationalArea area={area} es={es} cases={visibleCases} onOpen={setSelectedCaseId}/>}
        {area==="plans"&&<OperationalArea area={area} es={es} cases={visibleCases} onOpen={setSelectedCaseId}/>}
        {area==="administration"&&<section className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">{es?"Administración del programa":"Program administration"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{es?"Configure el nombre bilingüe y el prefijo inmutable de nuevos folios. Los folios existentes no cambian.":"Configure bilingual labels and the prefix for new immutable case numbers. Existing numbers never change."}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Nombre (ES)" value={programSetup.nameEs} onChange={v=>setProgramSetup({...programSetup,nameEs:v})}/>
            <Field label="Name (EN)" value={programSetup.nameEn} onChange={v=>setProgramSetup({...programSetup,nameEn:v})}/>
            <Field label={es?"Prefijo de folio":"Case prefix"} value={programSetup.prefix} onChange={v=>setProgramSetup({...programSetup,prefix:v.toUpperCase().replace(/[^A-Z0-9-]/g,"")})}/>
            <button disabled={!resolvedOrg||programMutation.isPending} onClick={()=>programMutation.mutate()} className="self-end rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{programMutation.isPending&&<Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>}{es?"Guardar programa":"Save program"}</button>
          </div>
        </section>}
        {area==="tasks"&&<section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">{es?"Alertas operativas":"Operational alerts"}</h2><div className="mt-3 space-y-2">{visibleAlerts.map((x:any)=><div key={x.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className={x.severity==="critical"?"font-semibold text-destructive":"font-medium"}>{es?x.title_es:x.title_en}</p><p className="text-xs text-muted-foreground">{x.alert_type} · {x.due_at?new Date(x.due_at).toLocaleString():"—"}</p></div><button disabled={acknowledgeMutation.isPending} onClick={()=>acknowledgeMutation.mutate(x.id)} className="rounded-lg border border-border px-3 py-1.5 text-xs">{es?"Resolver":"Resolve"}</button></div>)}{!visibleAlerts.length&&<p className="text-sm text-muted-foreground">{es?"No hay alertas pendientes.":"No pending alerts."}</p>}</div></section>}
        {area==="indicators"&&<section className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-end gap-3"><div><h2 className="font-semibold">{es?"Indicadores institucionales":"Institutional indicators"}</h2><p className="text-xs text-muted-foreground">{es?"Solo agregados; grupos pequeños se suprimen automáticamente.":"Aggregates only; small groups are automatically suppressed."}</p></div><Field label={es?"Desde":"From"} type="date" value={indicatorRange.from} onChange={v=>setIndicatorRange({...indicatorRange,from:v})}/><Field label={es?"Hasta":"To"} type="date" value={indicatorRange.to} onChange={v=>setIndicatorRange({...indicatorRange,to:v})}/></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{(indicators.data??[]).map((x:any,i:number)=><div key={x.id??i} className="rounded-lg border border-border p-4"><p className="text-xs uppercase text-muted-foreground">{x.name_es??x.indicator_code??x.code??(es?"Indicador":"Indicator")}</p><p className="mt-1 text-2xl font-semibold">{x.suppressed?(es?"Suprimido":"Suppressed"):(x.value??x.count??"—")}</p></div>)}{indicators.isLoading&&<Loader2 className="h-5 w-5 animate-spin"/>}{!indicators.isLoading&&!(indicators.data??[]).length&&<p className="text-sm text-muted-foreground">{es?"Sin datos agregados para el periodo.":"No aggregate data for this period."}</p>}</div></section>}
        {area==="activity"&&<TeamActivity es={es} account={organizationAccount} orgId={resolvedOrg} onOpenCase={setSelectedCaseId}/>}
        {area==="documents"&&<SocialDocumentsHub cases={visibleCases} people={visiblePeople} families={visibleFamilies} programs={programs} orgId={resolvedOrg} canCreateCases={canManageOrganization} onOpenCase={setSelectedCaseId} onRegisterPerson={()=>setCaseModalOpen(true)} onOpenNewCase={()=>setCaseModalOpen(true)}/>}
        {effectiveArea==="resources"&&<ResourceKnowledgeNetwork mode="resources" orgId={resolvedOrg}/>}
        {area==="knowledge"&&<KnowledgeCenter orgId={resolvedOrg}/>}
        {effectiveArea==="resourceAdmin"&&canAdministerResources&&<><ResourceKnowledgeNetwork mode="admin" orgId={resolvedOrg}/><KnowledgeCenter orgId={resolvedOrg} admin/></>}
        {["interventions","legal","psychosocial","referrals","transfers","closure"].includes(area)&&<OperationalArea area={area} es={es} cases={visibleCases} onOpen={setSelectedCaseId}/>} 
      </main>
    </div>
  </div>;
}

function OpenAndAssignCaseModal({open,es,draft,setDraft,programs,people,families,members,currentUserId,pending,onClose,onSubmit}:{
  open:boolean;es:boolean;draft:any;setDraft:(value:any)=>void;programs:any[];people:any[];families:any[];members:any[];
  currentUserId:string;pending:boolean;onClose:()=>void;onSubmit:()=>void;
}){
  if(!open)return null;
  const selected=people.find((p:any)=>p.id===draft.personId);
  const activeMembers=members.filter((m:any)=>m.status==="active");
  const validClient=Boolean(draft.personId||draft.newClientName.trim().length>=2);
  const validAssignee=Boolean(draft.assignedUserId&&activeMembers.some((m:any)=>m.user_id===draft.assignedUserId));
  return <div role="dialog" aria-modal="true" aria-label={es?"Abrir y asignar caso":"Open and Assign Case"} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[.16em] text-primary">{es?"Nuevo expediente":"New case"}</p><h2 className="text-xl font-semibold">{es?"Abrir y asignar caso":"Open and Assign Case"}</h2><p className="mt-1 text-sm text-muted-foreground">{es?"El cliente, el caso, la asignación, el historial y las alertas se guardan juntos.":"Client, case, assignment, history, and alerts are saved together."}</p></div><button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-sm">{es?"Cerrar":"Close"}</button></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="text-xs font-medium text-muted-foreground">{es?"Cliente existente":"Existing client"}<select value={draft.personId} onChange={e=>setDraft({...draft,personId:e.target.value,newClientName:""})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="">{es?"Registrar cliente nuevo":"Register new client"}</option>{people.map((p:any)=><option key={p.id} value={p.id}>{p.person_number} · {p.legal_name}</option>)}</select></label>
        {!draft.personId&&<Field label={es?"Nombre legal del cliente nuevo":"New client legal name"} value={draft.newClientName} onChange={v=>setDraft({...draft,newClientName:v})}/>}
        {selected&&<div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm md:col-span-2"><span className="font-semibold">{selected.legal_name}</span><span className="ml-2 text-muted-foreground">{selected.person_number}</span></div>}
        <label className="text-xs font-medium text-muted-foreground">{es?"Programa":"Program"}<select value={draft.programId||programs[0]?.id||""} onChange={e=>setDraft({...draft,programId:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{programs.map((p:any)=><option key={p.id} value={p.id}>{es?p.name_es:p.name_en} · {p.case_prefix}</option>)}</select></label>
        <label className="text-xs font-medium text-muted-foreground">{es?"Asignado a":"Assigned to"}<select value={draft.assignedUserId} onChange={e=>setDraft({...draft,assignedUserId:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="">{es?"Seleccione integrante del equipo":"Select team member"}</option>{activeMembers.map((m:any)=><option key={m.user_id} value={m.user_id}>{m.user_id===currentUserId?(es?"Yo":"Me"):m.name}{m.title?` — ${m.title}`:""} · {memberRoleLabel(m.role,es)}</option>)}</select></label>
        <label className="text-xs font-medium text-muted-foreground">{es?"Tipo de caso":"Case type"}<select value={draft.caseType} onChange={e=>setDraft({...draft,caseType:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="individual">{es?"Individual":"Individual"}</option><option value="minor_child">{es?"Menor / protección infantil":"Minor / Child"}</option><option value="family">{es?"Familia":"Family"}</option></select></label>
        {draft.caseType==="family"&&<label className="text-xs font-medium text-muted-foreground">{es?"Familia vinculada (opcional)":"Linked family (optional)"}<select value={draft.familyId} onChange={e=>setDraft({...draft,familyId:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="">—</option>{families.map((x:any)=><option key={x.id} value={x.id}>{x.family_number} · {x.family_name}</option>)}</select></label>}
        <label className="text-xs font-medium text-muted-foreground">{es?"Prioridad":"Priority"}<select value={draft.priority} onChange={e=>setDraft({...draft,priority:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="standard">{es?"Estándar":"Standard"}</option><option value="urgent">{es?"Urgente":"Urgent"}</option><option value="emergency">{es?"Emergencia":"Emergency"}</option></select></label>
      </div>
      {draft.priority==="emergency"&&<div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{es?"Emergencia crea alertas y una tarea de respuesta inmediata. Nyrava no sustituye a los servicios de emergencia.":"Emergency creates alerts and an immediate-response task. Nyrava does not replace emergency services."}</div>}
      <div className="mt-5 flex justify-end gap-3"><button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm">{es?"Cancelar":"Cancel"}</button><button type="button" disabled={pending||!programs.length||!validClient||!validAssignee} onClick={onSubmit} className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{pending&&<Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>}{es?"Abrir y asignar":"Open and assign"}</button></div>
    </section>
  </div>;
}

const MEMBER_ROLES=["firm_manager","supervisor","case_worker","legal_provider","psychosocial_provider","read_only"] as const;
const memberRoleLabel=(role:string,es:boolean)=>({
  firm_manager:["Gerente del despacho","Firm manager"],supervisor:["Supervisor","Supervisor"],case_worker:["Gestor del caso","Case worker"],
  legal_provider:["Profesional jurídico","Legal provider"],psychosocial_provider:["Profesional psicosocial","Psychosocial provider"],
  read_only:["Solo lectura","Read only"],owner:["Propietario","Owner"],admin:["Administrador","Administrator"],
} as Record<string,[string,string]>)[role]?.[es?0:1]??role.replaceAll("_"," ");

function TeamActivity({es,account,orgId,onOpenCase}:{es:boolean;account:any;orgId:string;onOpenCase?:(id:string)=>void}){
  const members=account?.members??[];
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [actionFilter, setActionFilter] = useState("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedDrawerActivityId, setSelectedDrawerActivityId] = useState<string | null>(null);
  const [selectedDrawerCaseId, setSelectedDrawerCaseId] = useState<string | null>(null);

  const getActivityFn = useServerFn(getTeamActivityEventsPaginated);
  const activityQuery = useQuery({
    queryKey: ["team-activity-paginated", orgId, page, pageSize, actionFilter, entityFilter, startDate, endDate],
    queryFn: () => getActivityFn({
      data: {
        orgId,
        page,
        pageSize,
        actionFilter: actionFilter !== "all" ? actionFilter : undefined,
        entityFilter: entityFilter !== "all" ? entityFilter : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      },
    }),
    enabled: Boolean(orgId),
  });

  const data = activityQuery.data;
  const events = data?.events ?? [];
  const total = data?.totalCount ?? 0;

  const handleFilterChange = (setter: (v: string) => void, val: string) => {
    setter(val);
    setPage(1);
  };

  return <section className="space-y-4">
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-semibold">{es ? "Actividad del equipo" : "Team activity"}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{es ? "Carga, vencimientos y actividad dentro de la organización seleccionada. Los eventos sensibles muestran metadatos, no contenido protegido." : "Workload, deadlines and activity inside the selected organization. Sensitive events show metadata, not protected content."}</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {members.map((m:any) => (
          <div key={m.id} className="rounded-lg border border-border p-3">
            <p className="font-medium">{m.name}</p>
            <p className="text-xs text-muted-foreground">{memberRoleLabel(m.role,es)}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <span>{es ? "Casos" : "Cases"}: <strong>{m.assigned_cases ?? 0}</strong></span>
              <span>{es ? "Pendientes" : "Open"}: <strong>{m.open_tasks ?? 0}</strong></span>
              <span className={(m.overdue_tasks ?? 0) > 0 ? "text-destructive" : ""}>{es ? "Vencidas" : "Overdue"}: <strong>{m.overdue_tasks ?? 0}</strong></span>
              <span>{es ? "Completadas" : "Done"}: <strong>{m.completed_tasks ?? 0}</strong></span>
              <span>{es ? "Canalizaciones" : "Referrals"}: <strong>{m.referrals ?? 0}</strong></span>
            </div>
          </div>
        ))}
      </div>
    </div>

    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h3 className="font-semibold text-foreground">{es ? "Historial de Actividad Institucional" : "Institutional Activity History"}</h3>
          <p className="text-xs text-muted-foreground">{es ? "Registro de auditoría cronológico con paginación en servidor." : "Chronological audit ledger with server-side pagination."}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={actionFilter}
            onChange={(e) => handleFilterChange(setActionFilter, e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            <option value="all">{es ? "Todas las acciones" : "All actions"}</option>
            <option value="insert">{es ? "Creación" : "Create"}</option>
            <option value="update">{es ? "Modificación" : "Update"}</option>
            <option value="delete">{es ? "Eliminación" : "Delete"}</option>
            <option value="member_invited">{es ? "Invitación de usuario" : "Member invited"}</option>
            <option value="member_activated">{es ? "Activación de usuario" : "Member activated"}</option>
            <option value="report_generated">{es ? "Informe generado" : "Report generated"}</option>
          </select>

          <select
            value={entityFilter}
            onChange={(e) => handleFilterChange(setEntityFilter, e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            <option value="all">{es ? "Todas las entidades" : "All entities"}</option>
            <option value="social_cases">{es ? "Expedientes" : "Cases"}</option>
            <option value="social_care_plans">{es ? "Planes de atención" : "Care plans"}</option>
            <option value="social_assessments">{es ? "Evaluaciones" : "Assessments"}</option>
            <option value="social_interventions">{es ? "Intervenciones" : "Interventions"}</option>
            <option value="social_referrals">{es ? "Canalizaciones" : "Referrals"}</option>
            <option value="social_documents">{es ? "Documentos" : "Documents"}</option>
            <option value="social_tasks">{es ? "Tareas" : "Tasks"}</option>
            <option value="social_community_campaigns">{es ? "Campañas comunitarias" : "Campaigns"}</option>
            <option value="organization_members">{es ? "Miembros del equipo" : "Team members"}</option>
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => handleFilterChange(setStartDate, e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          />
          <span className="text-muted-foreground">-</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => handleFilterChange(setEndDate, e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {activityQuery.isLoading ? (
          <div className="py-12 text-center text-xs text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
            <p className="mt-2">{es ? "Cargando registros de actividad..." : "Loading activity records..."}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground rounded-lg border border-dashed border-border/80">
            {es ? "No se encontraron registros de actividad con los filtros seleccionados." : "No activity records match the selected filters."}
          </div>
        ) : (
          events.map((e: any) => {
            const humanDescription = formatActivityDescription(e.event_type, e.entity_type, e.metadata, es);
            return (
              <div
                key={e.id}
                onClick={() => {
                  if (e.social_case_id) {
                    setSelectedDrawerActivityId(e.id);
                    setSelectedDrawerCaseId(e.social_case_id);
                  }
                }}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card p-3.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted/30 ${e.social_case_id ? "cursor-pointer" : ""}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground font-mono text-[11px]">
                    {e.event_type === "delete" ? "✕" : e.event_type === "insert" ? "+" : "✎"}
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">{humanDescription}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{new Date(e.occurred_at).toLocaleString()}</span>
                      {e.case_number && (
                        <span
                          onClick={(ev) => {
                            if (onOpenCase) {
                              ev.stopPropagation();
                              onOpenCase(e.social_case_id);
                            }
                          }}
                          className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary hover:underline"
                        >
                          {e.case_number}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {e.social_case_id && (
                  <span className="text-[11px] font-medium text-primary hover:underline">
                    {es ? "Ver detalle →" : "View detail →"}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-5">
        <NyravaPagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          es={es}
        />
      </div>
    </div>

    {selectedDrawerActivityId && selectedDrawerCaseId && (
      <CaseActivityDrawerModal
        activityId={selectedDrawerActivityId}
        caseId={selectedDrawerCaseId}
        es={es}
        onClose={() => {
          setSelectedDrawerActivityId(null);
          setSelectedDrawerCaseId(null);
        }}
        onNavigateTab={() => {
          const cid = selectedDrawerCaseId;
          setSelectedDrawerActivityId(null);
          setSelectedDrawerCaseId(null);
          if (onOpenCase && cid) onOpenCase(cid);
        }}
      />
    )}
  </section>;
}

function Metric({label,value,danger=false}:{label:string;value:number;danger?:boolean}){return <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p><p className={`mt-1 text-3xl font-semibold ${danger&&value>0?"text-destructive":""}`}>{value}</p></div>}
function Field({label,value,onChange,type="text"}:{label:string;value:string;onChange:(v:string)=>void;type?:string}){return <label className="block text-xs font-medium text-muted-foreground">{label}<input type={type} value={value} onChange={e=>onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"/></label>}
function CaseTable({cases,members=[],es,onOpen}:{cases:any[];members?:any[];es:boolean;onOpen:(id:string)=>void}){
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const total = cases.length;
  const from = (page - 1) * pageSize;
  const pagedCases = cases.slice(from, from + pageSize);

  return <div className="space-y-3">
    <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-3">{es?"Folio":"Case no."}</th>
            <th className="px-4 py-3">{es?"Tipo":"Type"}</th>
            <th className="px-4 py-3">{es?"Asignado a":"Assigned to"}</th>
            <th className="px-4 py-3">{es?"Estado":"Status"}</th>
            <th className="px-4 py-3">{es?"Riesgo":"Risk"}</th>
            <th className="px-4 py-3">{es?"Última actividad":"Last activity"}</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {pagedCases.map(c => {
            const assignee=members.find((m:any)=>m.user_id===c.assigned_case_manager);
            return <tr key={c.id} className="border-t border-border">
              <td className="px-4 py-3 font-mono">{c.case_number}</td>
              <td className="px-4 py-3">{c.case_type}</td>
              <td className="px-4 py-3">{assignee ? <><span className="font-medium">{assignee.name}</span>{assignee.title && <span className="block text-xs text-muted-foreground">{assignee.title}</span>}</> : <span className="text-muted-foreground">{es?"Sin asignar":"Unassigned"}</span>}</td>
              <td className="px-4 py-3">{c.status}</td>
              <td className={`px-4 py-3 ${c.risk_level === "critical" ? "font-semibold text-destructive" : ""}`}>{c.risk_level}</td>
              <td className="px-4 py-3 text-muted-foreground">{new Date(c.last_activity_at).toLocaleDateString()}</td>
              <td className="px-4 py-3 text-right">
                <button type="button" onClick={() => onOpen(c.id)} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">{es ? "Abrir" : "Open"}</button>
              </td>
            </tr>;
          })}
          {!cases.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{es ? "Sin casos autorizados" : "No authorized cases"}</td></tr>}
        </tbody>
      </table>
    </div>
    {cases.length > 0 && (
      <NyravaPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        es={es}
      />
    )}
  </div>;
}
function PeopleTable({people,es}:{people:any[];es:boolean}){return <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-sm"><thead><tr className="bg-muted/50 text-left"><th className="px-4 py-3">{es?"ID":"ID"}</th><th className="px-4 py-3">{es?"Persona":"Person"}</th><th className="px-4 py-3">{es?"Consentimiento":"Consent"}</th></tr></thead><tbody>{people.map(p=><tr key={p.id} className="border-t border-border"><td className="px-4 py-3 font-mono">{p.person_number}</td><td className="px-4 py-3">{p.legal_name}<span className="block text-xs text-muted-foreground">{p.preferred_name}</span></td><td className="px-4 py-3">{p.consent_status}</td></tr>)}{!people.length&&<tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">{es?"Aún no hay personas registradas":"No people registered yet"}</td></tr>}</tbody></table></div>}
function Empty({title,text}:{title:string;text:string}){return <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">{text}</p></section>}
function OperationalArea({area,es,cases,onOpen}:{area:string;es:boolean;cases:any[];onOpen:(id:string)=>void}){const labels:Record<string,[string,string,string,string]>={
assessments:["Evaluaciones versionadas","Versioned assessments","Cada clasificación requiere evidencia, razón, factores protectores, acciones y revisión.","Every classification requires evidence, reason, protective factors, actions and review."],
plans:["Planes de atención","Care plans","Las versiones aprobadas son inmutables y las revisiones crean una nueva versión.","Approved versions are immutable and revisions create a new version."],
interventions:["Intervenciones","Interventions","Registros estructurados por servicio y nivel de confidencialidad.","Structured records by service and confidentiality."],
legal:["Servicios jurídicos","Legal services","Las notas privilegiadas requieren permiso jurídico específico.","Privileged notes require specific legal permission."],
psychosocial:["Servicios psicosociales","Psychosocial services","Los expedientes clínicos completos permanecen restringidos.","Full clinical records remain restricted."],
referrals:["Canalizaciones","Referrals","Envío con consentimiento y verificación independiente del resultado.","Consent-gated sending and independently verified outcomes."],
tasks:["Tareas, alertas y citas","Tasks, alerts and appointments","Seguimiento de vencimientos, recurrencia y escalamiento.","Deadlines, recurrence and supervisor escalation."],
documents:["Documentos y consentimiento","Documents and consent","Originales privados, hash, versiones y descarga auditada.","Private originals, hashes, versions and audited downloads."],
transfers:["Transferencias","Transfers","Autoridad, consentimiento, selección y acuse de recibo.","Authority, consent, selection and receipt confirmation."],
closure:["Cierre y reapertura","Closure and reopening","Revisión supervisora; el caso cerrado queda de solo lectura.","Supervisor review; closed cases become read-only."],
indicators:["Indicadores institucionales","Institutional indicators","Datos agregados y supresión de grupos pequeños.","Aggregated data with small-group suppression."],
activity:["Actividad del Equipo","Team Activity","Libro de auditoría operativo, inmutable y sin contenido restringido.","Immutable operational audit ledger without restricted content."],
administration:["Administración","Administration","Programas, oficinas, roles, capacidades y acceso de soporte temporal.","Programs, offices, roles, capabilities and time-limited support access."],
};const l=labels[area]??["","","",""];return <><Empty title={es?l[0]:l[1]} text={(es?l[2]:l[3])+` · ${es?"Abra un caso para trabajar esta etapa.":"Open a case to work on this stage."}`}/><CaseTable cases={cases} es={es} onOpen={onOpen}/></>}

