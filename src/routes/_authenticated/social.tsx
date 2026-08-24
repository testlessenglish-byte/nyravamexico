import { createFileRoute } from "@tanstack/react-router";
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

export const Route=createFileRoute("/_authenticated/social")({
  head:()=>({meta:[
    {title:"Atención Integral — Nyrava México"},
    {name:"description",content:"Gestión social integral, separada de los expedientes jurídicos migratorios."},
  ]}),
  component:SocialCarePage,
});

type Area="dashboard"|"people"|"families"|"cases"|"caseWork"|"intake"|"assessments"|"plans"|"interventions"|"legal"|"psychosocial"|"referrals"|"resources"|"knowledge"|"resourceAdmin"|"tasks"|"documents"|"transfers"|"closure"|"indicators"|"activity"|"administration";
const PRIMARY_AREAS:Array<{id:Area;es:string;en:string;icon:typeof Activity}>=[
  {id:"dashboard",es:"Resumen",en:"Overview",icon:Activity},
  {id:"people",es:"Personas y familias",en:"People and Families",icon:Users},
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
  {id:"resourceAdmin",es:"Administrar recursos",en:"Manage Resources",icon:ShieldCheck},
];

function errorMessage(error:unknown):string{
  if(error instanceof Error&&error.message)return error.message;
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
  const [area,setArea]=useState<Area>("dashboard");
  const [selectedCaseId,setSelectedCaseId]=useState("");
  const [orgId,setOrgId]=useState("");
  const [query,setQuery]=useState("");
  const [programSetup,setProgramSetup]=useState({nameEs:"Atención Integral",nameEn:"Comprehensive Care",prefix:"NYR-SOC"});
  const [family,setFamily]=useState({name:"",primaryId:"",memberIds:[] as string[]});
  const today=new Date().toISOString().slice(0,10);const yearStart=`${today.slice(0,4)}-01-01`;
  const [indicatorRange,setIndicatorRange]=useState({from:yearStart,to:today});
  const [acceptedInvite,setAcceptedInvite]=useState("");
  const [caseModalOpen,setCaseModalOpen]=useState(false);
  const workspace=useQuery({
    queryKey:["social-workspace"],
    queryFn:()=>workspaceFn(),
    refetchInterval:5000,
    refetchOnWindowFocus:true,
  });
  const allOrganizations=workspace.data?.organizations??[];
  const allOrganizationAccounts=workspace.data?.organizationAccounts??[];
  const currentUserId=workspace.data?.userId??"";
  const employeeOrgIds=allOrganizationAccounts
    .filter((account:any)=>account.can_manage!==true&&(account.members??[]).some((member:any)=>member.user_id===currentUserId&&member.status==="active"))
    .map((account:any)=>account.orgId);
  const availableOrganizations=employeeOrgIds.length
    ? allOrganizations.filter((organization:any)=>employeeOrgIds.includes(organization.id))
    : allOrganizations;
  const requestedOrg=orgId&&availableOrganizations.some((organization:any)=>organization.id===orgId)?orgId:"";
  const resolvedOrg=requestedOrg||availableOrganizations[0]?.id||"";
  const organizationAccount=allOrganizationAccounts.find((x:any)=>x.orgId===resolvedOrg);
  const organizationMembers=organizationAccount?.members??[];
  const canManageOrganization=organizationAccount?.can_manage===true;
  const navigationAreas=canManageOrganization
    ? PRIMARY_AREAS
    : PRIMARY_AREAS.filter((item)=>["dashboard","cases","caseWork","tasks","documents"].includes(item.id));
  const programs=(workspace.data?.programs??[]).filter((p:any)=>p.org_id===resolvedOrg);
  const visibleCases=(workspace.data?.cases??[]).filter((c:any)=>c.org_id===resolvedOrg);
  const visiblePeople=(workspace.data?.people??[]).filter((p:any)=>p.org_id===resolvedOrg);
  const visibleFamilies=(workspace.data?.families??[]).filter((x:any)=>x.org_id===resolvedOrg);
  const visibleAlerts=(workspace.data?.alerts??[]).filter((x:any)=>x.org_id===resolvedOrg);
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
    if(!canManageOrganization&&["people","families","activity","administration"].includes(area)){
      setArea("dashboard");
    }
  },[area,canManageOrganization]);
  const stats=workspace.data?.stats;
  const filtered=useMemo(()=>{
    const q=query.trim().toLocaleLowerCase("es-MX"); if(!q)return visibleCases;
    return visibleCases.filter((c:any)=>[c.case_number,c.case_type,c.status,c.risk_level].some(v=>String(v??"").toLocaleLowerCase("es-MX").includes(q)));
  },[visibleCases,query]);

  if(workspace.isLoading)return <div className="p-8 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{es?"Cargando Atención Integral…":"Loading Comprehensive Care…"}</div>;
  if(selectedCaseId)return <div data-social-care-root className="mx-auto max-w-[1600px] p-4 md:p-6"><EscapedTextNormalizer/><SocialCaseWorkspace
    caseId={selectedCaseId}
    people={workspace.data?.people??[]}
    institutions={workspace.data?.institutions??[]}
    templates={workspace.data?.templates??[]}
    roleAssignments={workspace.data?.roleAssignments??[]}
    organizationMembers={organizationMembers}
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
          <select aria-label={es?"Organización activa":"Active organization"} value={resolvedOrg} onChange={e=>setOrgId(e.target.value)} disabled={!availableOrganizations.length} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground disabled:opacity-60">
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
          {navigationAreas.map(a=>{const Icon=a.icon;const active=a.id==="people"?area==="people"||area==="families":area===a.id;return <button key={a.id} onClick={()=>setArea(a.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${active?"bg-primary text-primary-foreground":"hover:bg-muted"}`}><Icon className="h-4 w-4"/>{es?a.es:a.en}</button>})}
          <details className="border-t border-border pt-2">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{es?"Herramientas y recursos":"Tools and resources"}</summary>
            <div className="mt-1 space-y-1">{CONTEXT_AREAS.map(a=>{const Icon=a.icon;return <button key={a.id} onClick={()=>setArea(a.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${area===a.id?"bg-primary text-primary-foreground":"hover:bg-muted"}`}><Icon className="h-4 w-4"/>{es?a.es:a.en}</button>})}</div>
          </details>
        </nav>
      </aside>

      <main className="min-w-0">
        {area==="dashboard"&&<>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label={es?"Casos activos":"Active cases"} value={stats?.active??0}/>
            <Metric label={es?"Riesgo crítico":"Critical risk"} value={stats?.critical??0} danger/>
            <Metric label={es?"Tareas vencidas":"Overdue tasks"} value={stats?.overdue??0}/>
            <Metric label={es?"Canalizaciones sin verificar":"Unverified referrals"} value={stats?.unverifiedReferrals??0}/>
          </div>
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-4">
            <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 text-warning"/><div><p className="text-sm font-semibold">{es?"Guía de escalamiento":"Escalation guidance"}</p><p className="text-sm text-muted-foreground">{EMERGENCY_GUIDANCE[locale]}</p></div></div>
          </div>
          {canManageOrganization&&!visibleCases.length&&<div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><div><p className="text-sm font-semibold">{es?"Registre su primer caso":"Register your first case"}</p><p className="text-xs text-muted-foreground">{es?"Registre o seleccione al cliente, defina el tipo y asigne al responsable en un solo flujo.":"Register or select the client, choose the case type, and assign responsibility in one workflow."}</p></div><button type="button" onClick={()=>setCaseModalOpen(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">{es?"Registrar nuevo caso":"Register New Case"}</button></div>}
          <CaseTable cases={visibleCases.slice(0,12)} es={es} onOpen={setSelectedCaseId}/>
        </>}

        {(area==="people"||area==="families")&&<div className="mb-4 flex gap-2 rounded-xl border border-border bg-card p-2">
          <button type="button" onClick={()=>setArea("people")} className={`rounded-lg px-4 py-2 text-sm font-medium ${area==="people"?"bg-primary text-primary-foreground":"hover:bg-muted"}`}>{es?"Personas":"People"}</button>
          <button type="button" onClick={()=>setArea("families")} className={`rounded-lg px-4 py-2 text-sm font-medium ${area==="families"?"bg-primary text-primary-foreground":"hover:bg-muted"}`}>{es?"Familias":"Families"}</button>
        </div>}

        {area==="caseWork"&&<section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5">
            <div><h2 className="font-semibold">{es?"Trabajo del caso":"Case Work"}</h2><p className="mt-1 text-sm text-muted-foreground">{es?"Abra un caso autorizado para trabajar ingreso, riesgo, plan, intervenciones, servicios, canalizaciones, documentos, actividad y cierre con el mismo expediente.":"Open an authorized case to work intake, risk, care plan, interventions, services, referrals, documents, activity, and closure in one continuous record."}</p></div>
            {canManageOrganization&&<button type="button" onClick={()=>setCaseModalOpen(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">{es?"Registrar nuevo caso":"Register New Case"}</button>}
          </div>
          <CaseTable cases={visibleCases} es={es} onOpen={setSelectedCaseId}/>
        </section>}

        {area==="people"&&<div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-semibold">{es?"Registrar persona":"Register person"}</h2>
            <p className="mb-4 text-xs text-muted-foreground">{es?"Capture únicamente los datos necesarios para el servicio.":"Collect only data necessary for the service."}</p>
            <div className="space-y-3">
              <Field label={es?"Nombre legal":"Legal name"} value={person.legalName} onChange={v=>setPerson({...person,legalName:v})}/>
              <Field label={es?"Nombre preferido":"Preferred name"} value={person.preferredName} onChange={v=>setPerson({...person,preferredName:v})}/>
              <Field label={es?"Teléfono":"Telephone"} value={person.telephone} onChange={v=>setPerson({...person,telephone:v})}/>
              <Field label="Email" type="email" value={person.email} onChange={v=>setPerson({...person,email:v})}/>
              <Field label={es?"Nacionalidad":"Nationality"} value={person.nationality} onChange={v=>setPerson({...person,nationality:v})}/>
              <button disabled={!resolvedOrg||person.legalName.trim().length<2||duplicates.isPending} onClick={()=>duplicates.mutate()} className="w-full rounded-lg border border-border px-3 py-2 text-sm"><Search className="mr-2 inline h-4 w-4"/>{es?"Buscar posibles duplicados":"Check possible duplicates"}</button>
              {(duplicates.data??[]).length>0&&<div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs"><strong>{es?"Revise antes de crear:":"Review before creating:"}</strong>{(duplicates.data??[]).map((d:any)=><div key={d.id}>{d.person_number} · {d.legal_name} ({Math.round(Number(d.similarity)*100)}%)</div>)}</div>}
              <button disabled={createPersonMutation.isPending||!resolvedOrg||person.legalName.trim().length<2} onClick={()=>createPersonMutation.mutate()} className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">{createPersonMutation.isPending&&<Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>}{es?"Registrar persona":"Register person"}</button>
            </div>
          </section>
          <PeopleTable people={visiblePeople} es={es}/>
        </div>}

        {area==="cases"&&<section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
            <div><h2 className="font-semibold">{es?"Casos de Atención Integral":"Comprehensive Care cases"}</h2><p className="text-xs text-muted-foreground">{es?"Cada caso se abre y asigna mediante una sola transacción auditable.":"Every case is opened and assigned through one auditable transaction."}</p></div>
            {canManageOrganization&&<button type="button" onClick={()=>setCaseModalOpen(true)} disabled={!resolvedOrg||!programs.length} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{es?"Registrar nuevo caso":"Register New Case"}</button>}
          </div>
          <div className="mb-4 flex flex-wrap gap-2"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={es?"Buscar por nombre, folio, teléfono, estado…":"Search name, ID, phone, status…"} className="min-w-[260px] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"/><button onClick={()=>search.mutate()} disabled={!resolvedOrg||search.isPending} className="rounded-lg border border-border px-4 py-2 text-sm"><Search className="mr-2 inline h-4 w-4"/>{es?"Búsqueda amplia":"Broad search"}</button></div>
          {search.data&&<div className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">{es?"Resultados autorizados":"Authorized results"}: {search.data.length}</div>}
          <CaseTable cases={filtered} es={es} onOpen={setSelectedCaseId}/>
        </section>}

        {area==="intake"&&<SocialIntakeManager orgId={resolvedOrg} programs={programs} people={visiblePeople} families={visibleFamilies} members={organizationMembers} onCaseOpened={setSelectedCaseId}/>}
        {area==="families"&&<div className="grid gap-4 xl:grid-cols-[420px_1fr]">
          <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">{es?"Registrar familia u hogar":"Register family or household"}</h2><p className="mb-4 text-xs text-muted-foreground">{es?"Cada integrante conserva su expediente individual y sus permisos.":"Each member keeps an individual record and permissions."}</p><div className="space-y-3"><Field label={es?"Nombre familiar":"Family name"} value={family.name} onChange={v=>setFamily({...family,name:v})}/><label className="block text-xs font-medium text-muted-foreground">{es?"Contacto principal":"Primary contact"}<select value={family.primaryId} onChange={e=>setFamily({...family,primaryId:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="">—</option>{visiblePeople.map((p:any)=><option key={p.id} value={p.id}>{p.person_number} · {p.legal_name}</option>)}</select></label><div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2"><p className="mb-2 text-xs font-medium text-muted-foreground">{es?"Integrantes":"Members"}</p>{visiblePeople.map((p:any)=><label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={family.memberIds.includes(p.id)} onChange={e=>setFamily({...family,memberIds:e.target.checked?[...family.memberIds,p.id]:family.memberIds.filter(id=>id!==p.id)})}/>{p.person_number} · {p.legal_name}</label>)}</div><button disabled={!family.name||!family.memberIds.length||familyMutation.isPending} onClick={()=>familyMutation.mutate()} className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{familyMutation.isPending&&<Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>}{es?"Guardar familia":"Save family"}</button></div></section>
          <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-sm"><thead><tr className="bg-muted/50 text-left"><th className="px-4 py-3">{es?"Folio":"Number"}</th><th className="px-4 py-3">{es?"Familia":"Family"}</th><th className="px-4 py-3">{es?"Contacto":"Primary contact"}</th></tr></thead><tbody>{visibleFamilies.map((x:any)=><tr key={x.id} className="border-t border-border"><td className="px-4 py-3 font-mono">{x.family_number}</td><td className="px-4 py-3">{x.family_name}</td><td className="px-4 py-3">{visiblePeople.find((p:any)=>p.id===x.primary_contact_person_id)?.legal_name??"—"}</td></tr>)}{!visibleFamilies.length&&<tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">—</td></tr>}</tbody></table></div>
        </div>}
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
        {area==="activity"&&<TeamActivity es={es} account={organizationAccount}/>}
        {area==="documents"&&<SocialDocumentsHub cases={visibleCases} people={visiblePeople} families={visibleFamilies} programs={programs} orgId={resolvedOrg} canCreateCases={canManageOrganization} onOpenCase={setSelectedCaseId} onRegisterPerson={()=>setArea("people")} onOpenNewCase={()=>setArea("cases")}/>}
        {area==="resources"&&<ResourceKnowledgeNetwork mode="resources" orgId={resolvedOrg}/>}
        {area==="knowledge"&&<KnowledgeCenter orgId={resolvedOrg}/>}
        {area==="resourceAdmin"&&<><ResourceKnowledgeNetwork mode="admin" orgId={resolvedOrg}/><KnowledgeCenter orgId={resolvedOrg} admin/></>}
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

function TeamActivity({es,account}:{es:boolean;account:any}){
  const members=account?.members??[];const activity=account?.recent_activity??[];
  return <section className="space-y-4"><div className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">{es?"Actividad del equipo":"Team activity"}</h2><p className="mt-1 text-xs text-muted-foreground">{es?"Carga, vencimientos y actividad dentro de la organización seleccionada. Los eventos sensibles muestran metadatos, no contenido protegido.":"Workload, deadlines and activity inside the selected organization. Sensitive events show metadata, not protected content."}</p><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{members.map((m:any)=><div key={m.id} className="rounded-lg border border-border p-3"><p className="font-medium">{m.name}</p><p className="text-xs text-muted-foreground">{memberRoleLabel(m.role,es)}</p><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><span>{es?"Casos":"Cases"}: <strong>{m.assigned_cases??0}</strong></span><span>{es?"Pendientes":"Open"}: <strong>{m.open_tasks??0}</strong></span><span className={(m.overdue_tasks??0)>0?"text-destructive":""}>{es?"Vencidas":"Overdue"}: <strong>{m.overdue_tasks??0}</strong></span><span>{es?"Completadas":"Done"}: <strong>{m.completed_tasks??0}</strong></span><span>{es?"Canalizaciones":"Referrals"}: <strong>{m.referrals??0}</strong></span></div></div>)}</div></div><div className="rounded-xl border border-border bg-card p-5"><h3 className="font-semibold">{es?"Actividad reciente":"Recent activity"}</h3><div className="mt-3 space-y-2">{activity.map((e:any)=><div key={e.id} className="rounded-lg border border-border p-3 text-sm">{new Date(e.occurred_at).toLocaleString()} · {e.event_type} · {e.entity_type}{e.case_number?` · ${e.case_number}`:""}</div>)}{!activity.length&&<p className="text-sm text-muted-foreground">—</p>}</div></div></section>;
}

function Metric({label,value,danger=false}:{label:string;value:number;danger?:boolean}){return <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p><p className={`mt-1 text-3xl font-semibold ${danger&&value>0?"text-destructive":""}`}>{value}</p></div>}
function Field({label,value,onChange,type="text"}:{label:string;value:string;onChange:(v:string)=>void;type?:string}){return <label className="block text-xs font-medium text-muted-foreground">{label}<input type={type} value={value} onChange={e=>onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"/></label>}
function CaseTable({cases,es,onOpen}:{cases:any[];es:boolean;onOpen:(id:string)=>void}){return <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-sm"><thead><tr className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="px-4 py-3">{es?"Folio":"Case no."}</th><th className="px-4 py-3">{es?"Tipo":"Type"}</th><th className="px-4 py-3">{es?"Estado":"Status"}</th><th className="px-4 py-3">{es?"Riesgo":"Risk"}</th><th className="px-4 py-3">{es?"Última actividad":"Last activity"}</th><th className="px-4 py-3"></th></tr></thead><tbody>{cases.map(c=><tr key={c.id} className="border-t border-border"><td className="px-4 py-3 font-mono">{c.case_number}</td><td className="px-4 py-3">{c.case_type}</td><td className="px-4 py-3">{c.status}</td><td className={`px-4 py-3 ${c.risk_level==="critical"?"font-semibold text-destructive":""}`}>{c.risk_level}</td><td className="px-4 py-3 text-muted-foreground">{new Date(c.last_activity_at).toLocaleDateString()}</td><td className="px-4 py-3 text-right"><button type="button" onClick={()=>onOpen(c.id)} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">{es?"Abrir":"Open"}</button></td></tr>)}{!cases.length&&<tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">{es?"Sin casos autorizados":"No authorized cases"}</td></tr>}</tbody></table></div>}
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
