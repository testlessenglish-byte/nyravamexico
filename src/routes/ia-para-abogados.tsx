import { createFileRoute, Link } from "@tanstack/react-router";
import {
  DocsLayout,
  DocsSection,
  Callout,
  breadcrumbJsonLd,
  CANONICAL_BASE,
} from "@/components/DocsLayout";

const title = "IA para Abogados en México | Nyrava México";
const description =
  "Descubre cómo la inteligencia artificial puede ayudar a abogados en México a analizar expedientes, evidencia, argumentos y documentación jurídica con Nyrava México.";
const crumbs = [
  { label: "Recursos", to: "/resources" },
  { label: "IA para abogados", to: "/ia-para-abogados" },
];

export const Route = createFileRoute("/ia-para-abogados")({
  head: () => {
    const url = `${CANONICAL_BASE}/ia-para-abogados`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { property: "og:locale", content: "es_MX" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:url", content: url },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        { type: "application/ld+json", children: breadcrumbJsonLd(CANONICAL_BASE, crumbs) },
      ],
    };
  },
  component: IaParaAbogados,
});

function IaParaAbogados() {
  return (
    <DocsLayout
      eyebrow="Guía para profesionales del derecho"
      title="IA para Abogados en México"
      description="Usos prácticos, límites y criterios de revisión para incorporar inteligencia artificial al análisis jurídico en México."
      crumbs={crumbs}
      toc={[
        { id: "que-es", label: "Qué es la IA jurídica" },
        { id: "expedientes", label: "Expedientes y documentos" },
        { id: "argumentos", label: "Argumentos jurídicos" },
        { id: "cronologias", label: "Cronologías" },
        { id: "evidencia", label: "Análisis de evidencia" },
        { id: "investigacion", label: "Investigación y fuentes" },
        { id: "riesgos", label: "Riesgos y verificación" },
        { id: "nyrava", label: "El enfoque de Nyrava" },
        { id: "confidencialidad", label: "Confidencialidad" },
        { id: "empezar", label: "Cómo empezar" },
      ]}
    >
      <DocsSection id="que-es" heading="¿Qué es la inteligencia artificial para abogados?">
        <p>
          La inteligencia artificial aplicada al trabajo jurídico reúne herramientas que ayudan a
          procesar información, reconocer patrones y generar propuestas de texto. En un despacho,
          puede servir para organizar un expediente, comparar documentos o preparar una primera
          relación de cuestiones que requieren estudio.
        </p>
        <p>
          Su utilidad depende de la calidad de los documentos y de una pregunta bien delimitada. Un
          resumen generado por IA no equivale a una conclusión jurídica: el abogado debe
          contrastarlo con el expediente, el derecho aplicable y el contexto del asunto. En México,
          esto incluye distinguir la materia, el fuero, la entidad federativa y el momento relevante
          para el análisis.
        </p>
        <Callout title="Apoyo al criterio profesional">
          La IA no sustituye a las abogadas y los abogados ni garantiza resultados legales. La
          estrategia, la revisión y las decisiones sobre el asunto permanecen bajo responsabilidad
          profesional.
        </Callout>
      </DocsSection>

      <DocsSection id="expedientes" heading="Análisis de expedientes y documentos">
        <p>
          La IA puede apoyar la clasificación de contratos, promociones, resoluciones,
          comunicaciones y anexos; extraer nombres, fechas y cantidades; y elaborar resúmenes para
          orientar la lectura. Conviene pedir que cada hallazgo incluya el documento y el pasaje de
          origen, en lugar de aceptar un resumen sin referencias.
        </p>
        <p>
          Por ejemplo, al revisar una controversia contractual, puede comparar las obligaciones
          pactadas con las comunicaciones sobre entregas y pagos. El profesional debe comprobar los
          anexos, las modificaciones y las páginas omitidas. Una digitalización borrosa o un error
          de reconocimiento de texto puede cambiar una cifra, una fecha o el sentido de una
          cláusula.
        </p>
      </DocsSection>

      <DocsSection id="argumentos" heading="Identificación de argumentos y cuestiones jurídicas">
        <p>
          Una herramienta de análisis puede ayudar a separar hechos alegados, documentos de soporte
          y preguntas pendientes. También puede proponer líneas de argumentación y posibles
          objeciones para que el equipo jurídico las examine.
        </p>
        <p>
          Una forma útil de trabajar es solicitar, para cada cuestión, el hecho que la origina, su
          respaldo documental, la información faltante y el argumento contrario. La procedencia de
          una acción, la competencia y la estrategia procesal requieren revisión del abogado; no
          deben darse por acreditadas porque el texto generado resulte convincente.
        </p>
      </DocsSection>

      <DocsSection id="cronologias" heading="Cronologías y organización de información">
        <p>
          Ordenar los acontecimientos permite detectar intervalos sin documentación y versiones
          incompatibles. La IA puede preparar una cronología con fecha, evento y referencia, así
          como distinguir la fecha de un hecho de la fecha en que fue relatado o incorporado al
          expediente.
        </p>
        <p>
          Si dos documentos señalan fechas distintas, la diferencia debe mantenerse visible hasta
          aclararla. Una cronología de trabajo no es un cómputo validado de plazos: revise por
          separado las notificaciones, las reglas aplicables y los días relevantes antes de fijar un
          vencimiento.
        </p>
      </DocsSection>

      <DocsSection id="evidencia" heading="Análisis de evidencia con respaldo documental">
        <p>
          Relacionar declaraciones, dictámenes y documentos puede facilitar la identificación de
          coincidencias, contradicciones y vacíos de información. Una matriz que vincule cada
          afirmación con su fuente ayuda a distinguir lo documentado de lo que sólo se infiere.
        </p>
        <p>
          La ausencia de un dato en los archivos cargados no demuestra que un hecho no ocurrió.
          Tampoco una contradicción detectada automáticamente establece falsedad. La autenticidad,
          integridad, admisibilidad y alcance de los elementos probatorios exigen valoración
          jurídica y, cuando corresponda, revisión pericial.
        </p>
      </DocsSection>

      <DocsSection id="investigacion" heading="Investigación y autoridades jurídicas en México">
        <p>
          La IA puede sugerir términos de búsqueda y organizar las autoridades que el abogado reúne.
          Antes de utilizar una referencia, consulte el texto original: una cita con formato
          correcto puede ser inexistente, estar desactualizada o referirse a un problema distinto.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Consulte el{" "}
            <a href="https://sjf2.scjn.gob.mx/" className="text-primary hover:underline">
              Semanario Judicial de la Federación
            </a>{" "}
            para contrastar las tesis y ejecutorias citadas. Revise su identificación, órgano
            emisor, contenido y aplicabilidad al caso.
          </li>
          <li>
            Revise las publicaciones y reformas federales en el{" "}
            <a href="https://www.dof.gob.mx/" className="text-primary hover:underline">
              Diario Oficial de la Federación
            </a>
            , incluidos los transitorios relevantes.
          </li>
          <li>
            Para asuntos locales, consulte las fuentes oficiales de la entidad correspondiente.
            Confirme la versión normativa aplicable a los hechos y al procedimiento.
          </li>
        </ul>
        <p>
          Conserve la referencia consultada y explique por qué resulta pertinente. La investigación
          no termina al encontrar una frase favorable: también requiere examinar el contexto y los
          criterios que podrían llevar a una conclusión diferente.
        </p>
      </DocsSection>

      <DocsSection id="riesgos" heading="Riesgos de la IA jurídica y revisión de fuentes">
        <p>
          Las alucinaciones son respuestas plausibles que contienen información inventada o
          incorrecta. Pueden aparecer como hechos que no constan en el expediente, citas
          equivocadas, precedentes inexistentes o interpretaciones que omiten excepciones. Otros
          riesgos incluyen la pérdida de contexto, los sesgos y la exposición de información
          confidencial.
        </p>
        <Callout variant="warning" title="Una referencia no es una garantía de exactitud">
          Abra la fuente y compruebe que respalda la afirmación concreta. Ni un enlace ni una cita
          automatizada eliminan la necesidad de revisión profesional.
        </Callout>
        <p>Antes de incorporar un resultado a un informe, una estrategia o un escrito:</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Coteje nombres, fechas, cifras y citas textuales con los documentos originales.</li>
          <li>Separe hechos documentados, versiones de las partes e inferencias del sistema.</li>
          <li>Verifique la existencia, vigencia y pertinencia de cada autoridad jurídica.</li>
          <li>Revise omisiones, argumentos contrarios y limitaciones del material analizado.</li>
          <li>
            Corrija o descarte lo que no pueda sustentarse y documente la revisión del abogado
            responsable.
          </li>
        </ol>
      </DocsSection>

      <DocsSection id="nyrava" heading="Cómo aborda Nyrava México el análisis jurídico">
        <p>
          Nyrava México organiza el análisis alrededor de los documentos del expediente y sus
          referencias. Su enfoque combina extracción de información, cronologías, revisión de
          evidencia y estructuración de cuestiones jurídicas para facilitar el trabajo del
          profesional.
        </p>
        <p>
          Las referencias al material de origen y los controles de fundamentación ayudan a revisar
          los hallazgos; no eliminan la posibilidad de errores ni sustituyen la lectura de las
          fuentes. El alcance del análisis depende del material disponible y de las funciones
          utilizadas.
        </p>
        <p>
          Conozca{" "}
          <Link to="/how-it-works" className="text-primary hover:underline">
            cómo funciona Nyrava México
          </Link>
          , revise los{" "}
          <Link to="/resources" className="text-primary hover:underline">
            informes de muestra por materia jurídica
          </Link>{" "}
          y consulte la{" "}
          <Link to="/responsible-ai" className="text-primary hover:underline">
            política de IA responsable
          </Link>{" "}
          para evaluar este enfoque antes de aplicarlo a un asunto.
        </p>
      </DocsSection>

      <DocsSection
        id="confidencialidad"
        heading="Seguridad y confidencialidad antes de cargar un expediente"
      >
        <p>
          Antes de usar cualquier servicio de IA, determine qué información necesita compartir y si
          cuenta con autorización para hacerlo. Reduzca los datos personales a lo necesario y
          considere trabajar inicialmente con documentos sintéticos o anonimizados.
        </p>
        <p>
          Revise quién puede acceder a los archivos, qué proveedores intervienen en el
          procesamiento, las condiciones de conservación y eliminación y los usos permitidos de los
          datos. Si configura un proveedor de IA externo, examine también sus términos; no suponga
          que todas las herramientas ofrecen las mismas condiciones.
        </p>
        <p>
          Para valorar el uso de Nyrava en su despacho, consulte sus{" "}
          <Link to="/security" className="text-primary hover:underline">
            prácticas de seguridad
          </Link>
          , la información sobre{" "}
          <Link to="/confidentiality" className="text-primary hover:underline">
            confidencialidad
          </Link>{" "}
          y la{" "}
          <Link to="/privacy" className="text-primary hover:underline">
            política de privacidad
          </Link>
          . Resuelva las dudas sobre el tratamiento de información antes de cargar documentos
          sensibles.
        </p>
      </DocsSection>

      <DocsSection id="empezar" heading="Pruebe Nyrava México con un ejercicio controlado">
        <p>
          Comience con un expediente de muestra y una pregunta concreta. Compare los hallazgos con
          los documentos, compruebe las referencias y valore si el resultado ayuda a su forma de
          trabajo. Mantenga la revisión del abogado como parte del proceso desde la primera prueba.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/auth"
            className="inline-flex rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Probar Nyrava México
          </Link>
          <Link to="/contact" className="text-primary hover:underline">
            Consultar con el equipo
          </Link>
        </div>
      </DocsSection>
    </DocsLayout>
  );
}
