import { createFileRoute, Link } from "@tanstack/react-router";
import { DocsLayout, DocsSection, Callout, breadcrumbJsonLd, CANONICAL_BASE } from "@/components/DocsLayout";
import { FileText } from "lucide-react";

type Sample = {
  slug: string;
  practiceArea: string;
  title: string;
  summary: string;
  highlights: string[];
};

const SAMPLES: Sample[] = [
  {
    slug: "penal",
    practiceArea: "Derecho Penal",
    title: "Causa penal — robo calificado con violencia",
    summary: "Análisis del artículo 16 constitucional sobre detención sin control judicial oportuno, artículo 20 sobre declaración ministerial sin defensor presente y reconstrucción probatoria de la detención.",
    highlights: [
      "Cuestiones constitucionales estructuradas con citas al informe policial homologado y a la audiencia de control de detención.",
      "Contradicciones detectadas automáticamente entre la declaración de la víctima y el audio de la cámara corporal.",
      "Estructura del incidente de exclusión de prueba ilícita generada a partir del análisis constitucional.",
    ],
  },
  {
    slug: "responsabilidad-civil",
    practiceArea: "Derecho Civil",
    title: "Accidente de tránsito — vehículo de carga vs. particular",
    summary: "Reconstrucción de la secuencia del siniestro a partir del parte de tránsito, bitácora de viaje, notas de ingreso a urgencias y declaración del demandado.",
    highlights: [
      "Línea de tiempo minuto a minuto anclada a la bitácora de viaje.",
      "Plan de rehabilitación cotejado con los diagnósticos del expediente clínico.",
      "Marco de cuantificación del daño con citas probatorias verificadas.",
    ],
  },
  {
    slug: "responsabilidad-medica",
    practiceArea: "Derecho Civil",
    title: "Responsabilidad médica — urgencias y diagnóstico tardío",
    summary: "Construcción de la cronología de atención en urgencias a partir del expediente clínico, acta de investigación interna y dictamen pericial.",
    highlights: [
      "Análisis de lex artis ad hoc fundamentado en el dictamen pericial.",
      "Hallazgos periciales conciliados con la secuencia de notas médicas.",
      "Acta de investigación interna correlacionada con la línea de tiempo clínica.",
    ],
  },
  {
    slug: "laboral",
    practiceArea: "Derecho Laboral",
    title: "Despido injustificado con reclamo de hostigamiento",
    summary: "Evaluación de tres años de historial de desempeño, queja interna ante Recursos Humanos y comunicaciones para analizar la temporalidad y causalidad del despido.",
    highlights: [
      "Análisis de pretexto vinculado a evaluaciones de desempeño específicas.",
      "Queja interna conciliada con la bitácora de incidencias laborales.",
      "Cronología de actividad protegida vs. actos perjudiciales generada automáticamente.",
    ],
  },
  {
    slug: "familiar",
    practiceArea: "Derecho Familiar",
    title: "Divorcio con guarda y custodia y alegaciones de violencia familiar",
    summary: "Conciliación de la denuncia de violencia familiar, informe de trabajo social y declaraciones patrimoniales en conflicto.",
    highlights: [
      "Comparativa cruzada de declaraciones parentales en el informe de trabajo social y testimonios.",
      "Línea de tiempo de la denuncia sobrepuesta a las fechas de la declaración patrimonial.",
      "Factores del interés superior de la niñez identificados con soporte probatorio.",
    ],
  },
  {
    slug: "amparo",
    practiceArea: "Amparo",
    title: "Amparo directo — cuestiones probatorias y constitucionales",
    summary: "Reconstrucción de la secuela procesal a partir de la demanda de amparo, actas de audiencia, informe justificado y alegatos.",
    highlights: [
      "Cronología procesal extraída para la sección de antecedentes del acto reclamado.",
      "Análisis del principio de definitividad con citas directas al expediente.",
      "Conceptos de violación estructurados con sustento jurisprudencial y doctrinal.",
    ],
  },
  {
    slug: "constitucional",
    practiceArea: "Derecho Constitucional / Derechos Humanos",
    title: "Uso excesivo de la fuerza y responsabilidad de la autoridad",
    summary: "Análisis del artículo 1° constitucional con agrupación de declaraciones policiales, bitácora de asuntos internos y declaración ministerial.",
    highlights: [
      "Contradicciones testimoniales entre la bitácora interna y la declaración ministerial.",
      "Teoría de responsabilidad institucional sustentada en el historial de quejas.",
      "Esquema de reparación integral del daño vinculado a dictámenes médicos y testimonios.",
    ],
  },
  {
    slug: "fiscal",
    practiceArea: "Derecho Fiscal",
    title: "Resolución determinante y juicio de nulidad ante el TFJA",
    summary: "Conciliación del acta final de visita domiciliaria, estados de cuenta bancarios y registros contables para el juicio contencioso administrativo.",
    highlights: [
      "Conciliación de depósitos vinculada a CFDI y registros bancarios.",
      "Acreditación de deducciones e inversiones con bitácoras de soporte.",
      "Resolución del recurso de revocación integrada en la reconstrucción fáctica de la demanda.",
    ],
  },
  {
    slug: "mercantil",
    practiceArea: "Derecho Mercantil",
    title: "Disputa contractual mercantil con reconvención",
    summary: "Contrato de compraventa mercantil, auxiliares contables de pagos, correos electrónicos y peritaje de inspección para análisis de incumplimiento y reconvención.",
    highlights: [
      "Análisis de registros de pago anclado a la contabilidad del expediente.",
      "Dictamen de inspección correlacionado con los entregables contractuales.",
      "Teoría de la reconvención estructurada con citas de soporte.",
    ],
  },
];

export const Route = createFileRoute("/resources")({
  head: () => {
    const url = `${CANONICAL_BASE}/resources`;
    const desc = "Informes de muestra anonimizados en materias del derecho mexicano: penal, civil, laboral, familiar, amparo, derechos humanos, fiscal y mercantil.";
    return {
      meta: [
        { title: "Recursos — Informes de Muestra por Materia Jurídica | Nyrava México" },
        { name: "description", content: desc },
        { property: "og:title", content: "Recursos y Casos de Muestra — Nyrava México" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: "Recursos — Nyrava México" },
        { name: "twitter:description", content: desc },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [{
        type: "application/ld+json",
        children: breadcrumbJsonLd(CANONICAL_BASE, [{ label: "Recursos", to: "/resources" }]),
      }],
    };
  },
  component: Resources,
});

function Resources() {
  return (
    <DocsLayout
      eyebrow="Recursos"
      title="Informes de muestra por materia jurídica"
      description="Resúmenes breves de análisis de Nyrava en materias clave del derecho mexicano. Cada resumen describe el expediente procesado y los puntos clave del reporte generado."
      crumbs={[{ label: "Recursos", to: "/resources" }]}
    >
      <DocsSection heading="Guía de inteligencia artificial para la práctica jurídica">
        <p>
          Explore nuestra guía de <Link to="/ia-para-abogados" className="text-primary hover:underline">IA para abogados en México</Link>: usos en el análisis de expedientes, verificación de fuentes y precauciones de confidencialidad antes de incorporar estas herramientas a su trabajo.
        </p>
      </DocsSection>

      <Callout variant="info" title="Material sintético y anonimizado">
        Los expedientes de muestra son composiciones sintéticas construidas para fines de evaluación técnica. No proceden de asuntos reales ni representan a ninguna persona en particular.
      </Callout>

      <DocsSection>
        <div className="my-4 grid gap-4 sm:grid-cols-2">
          {SAMPLES.map((s) => (
            <div key={s.slug} className="flex flex-col rounded-xl border border-border/60 bg-card/30 p-5">
              <div className="mb-3 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.2em] text-primary">
                <FileText className="h-3.5 w-3.5" />
                {s.practiceArea}
              </div>
              <div className="text-[14px] font-semibold text-foreground">{s.title}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{s.summary}</p>
              <ul className="mt-3 space-y-1 text-[12px] text-muted-foreground">
                {s.highlights.map((h, i) => (
                  <li key={i} className="pl-4 -indent-4">→ {h}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DocsSection>

      <DocsSection heading="¿Desea ver un informe en su materia de práctica?">
        <p>
          Solicite una demostración personalizada a través de la página de{" "}
          <Link to="/contact" className="text-primary hover:underline">Contacto</Link> e
          indíquenos qué materia jurídica le interesa evaluar. Los despachos registrados pueden ejecutar cualquiera de los expedientes de muestra directamente desde el panel de pruebas.
        </p>
      </DocsSection>
    </DocsLayout>
  );
}
