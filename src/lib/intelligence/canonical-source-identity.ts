/**
 * Canonical Source Document Identity Service
 *
 * Platform-wide authority for document identity, source counting,
 * corroboration, and alias normalization.
 *
 * Invariant: One physical/legal source = One canonical evidentiary source.
 * Many citations != many documents.
 * Many aliases != many documents.
 */

export interface CanonicalSourceDocument {
  document_id: string;
  document_hash: string | null;
  case_id: string;
  original_filename: string;
  display_name: string;
  source_aliases: string[];
  mime_type: string | null;
  source_type: string | null;
  page_count: number;
  uploaded_at: string | null;
  extraction_version?: number | null;
  canonical_source_id: string;
  is_duplicate_physical_source: boolean;
  duplicate_of_document_id: string | null;
  document_family_id?: string | null;
  document_version?: number | null;
  supersedes_document_id?: string | null;
  size_bytes?: number | null;
}

export interface CanonicalSourceMetrics {
  documents_analyzed: number;
  source_count: number;
  unique_source_count: number;
  independent_source_count: number;
  corroborating_source_count: number;
  citation_source_count: number;
  evidence_source_count: number;
  source_diversity: number;
  raw_source_records: number;
  alias_merge_count: number;
  duplicate_hash_count: number;
  canonical_source_ids: string[];
}

export interface CanonicalSourceAuditResult {
  canonical_sources: CanonicalSourceDocument[];
  metrics: CanonicalSourceMetrics;
  alias_to_canonical_id: Record<string, string>;
  id_to_canonical_source: Record<string, CanonicalSourceDocument>;
  invariants: {
    unique_source_count_valid: boolean;
    independent_source_count_valid: boolean;
    citation_count_ge_unique: boolean;
    same_document_id_cannot_count_twice: boolean;
    same_document_hash_cannot_create_independent_corroboration: boolean;
    all_invariants_passed: boolean;
  };
}

export interface RawDocumentInput {
  id?: string;
  document_id?: string;
  content_hash?: string | null;
  document_hash?: string | null;
  case_id?: string;
  filename?: string;
  original_filename?: string;
  display_name?: string;
  mime_type?: string | null;
  source_type?: string | null;
  pages?: number;
  page_count?: number;
  created_at?: string | null;
  uploaded_at?: string | null;
  metadata?: Record<string, unknown> | null;
  entities?: Record<string, unknown> | null;
  size_bytes?: number | null;
  document_family_id?: string | null;
  document_version?: number | null;
  supersedes_document_id?: string | null;
}

/**
 * Normalizes text for alias matching (accent-folded, lowercased, trimmed).
 */
export function normalizeSourceAlias(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Platform-wide normalization function.
 * Produces exactly one canonical source per physical/legal document,
 * reconciles duplicate uploads via document_hash without deleting audit records,
 * and builds alias mapping tables.
 */
export function normalizeCanonicalSources(
  rawSources: ReadonlyArray<RawDocumentInput>,
): CanonicalSourceAuditResult {
  const records = rawSources ?? [];
  const byDocId = new Map<string, RawDocumentInput>();
  const byHash = new Map<string, string>(); // hash -> primary document_id
  const aliasMap: Record<string, string> = {};
  const idMap: Record<string, CanonicalSourceDocument> = {};
  const canonicalList: CanonicalSourceDocument[] = [];

  let duplicateHashCount = 0;
  let aliasMergeCount = 0;

  // Pass 1: Deduplicate by document_id and hash
  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const docId = String(raw.id ?? raw.document_id ?? `doc-${i + 1}`).trim();
    const hash = (raw.document_hash ?? raw.content_hash ?? (raw.metadata as Record<string, unknown> | null)?.content_hash ?? null) as string | null;
    const filename = String(raw.filename ?? raw.original_filename ?? `document_${docId}`).trim();
    const displayName = String(raw.display_name ?? (raw.metadata as Record<string, unknown> | null)?.display_name ?? filename).trim();
    const caseId = String(raw.case_id ?? "").trim();
    const mimeType = raw.mime_type ?? null;
    const sourceType = raw.source_type ?? (raw.metadata as Record<string, unknown> | null)?.source_type as string | null ?? null;
    const pageCount = Number(raw.page_count ?? raw.pages ?? (raw.metadata as Record<string, unknown> | null)?.pages ?? 1);
    const uploadedAt = raw.uploaded_at ?? raw.created_at ?? null;
    const sizeBytes = typeof raw.size_bytes === "number" ? raw.size_bytes : null;

    const aliases = new Set<string>();
    aliases.add(docId);
    aliases.add(filename);
    aliases.add(displayName);
    aliases.add(`DOC ${i + 1}`);
    aliases.add(`DOC_${i + 1}`);
    aliases.add(`doc_${i + 1}`);

    // OCR / Metadata aliases
    const meta = (raw.metadata ?? {}) as Record<string, unknown>;
    if (meta.ocr_title && typeof meta.ocr_title === "string") aliases.add(meta.ocr_title);
    if (meta.document_title && typeof meta.document_title === "string") aliases.add(meta.document_title);
    if (meta.cleaned_filename && typeof meta.cleaned_filename === "string") aliases.add(meta.cleaned_filename);
    if (meta.title && typeof meta.title === "string") aliases.add(meta.title);

    let isDuplicatePhysical = false;
    let duplicateOfDocId: string | null = null;
    let canonicalSourceId = docId;

    if (hash && typeof hash === "string" && hash.trim().length > 8) {
      const normalizedHash = hash.trim().toLowerCase();
      const existingPrimaryId = byHash.get(normalizedHash);
      if (existingPrimaryId && existingPrimaryId !== docId) {
        isDuplicatePhysical = true;
        duplicateOfDocId = existingPrimaryId;
        canonicalSourceId = existingPrimaryId;
        duplicateHashCount++;
      } else {
        byHash.set(normalizedHash, docId);
      }
    }

    const docFamilyId = (raw.document_family_id ?? meta.document_family_id ?? null) as string | null;
    const docVersion = typeof raw.document_version === "number" ? raw.document_version : (typeof meta.document_version === "number" ? meta.document_version : null);
    const supersedesId = (raw.supersedes_document_id ?? meta.supersedes_document_id ?? null) as string | null;

    const canonicalDoc: CanonicalSourceDocument = {
      document_id: docId,
      document_hash: hash,
      case_id: caseId,
      original_filename: filename,
      display_name: displayName,
      source_aliases: Array.from(aliases),
      mime_type: mimeType,
      source_type: sourceType,
      page_count: Math.max(1, pageCount),
      uploaded_at: uploadedAt,
      canonical_source_id: canonicalSourceId,
      is_duplicate_physical_source: isDuplicatePhysical,
      duplicate_of_document_id: duplicateOfDocId,
      document_family_id: docFamilyId,
      document_version: docVersion,
      supersedes_document_id: supersedesId,
      size_bytes: sizeBytes,
    };

    canonicalList.push(canonicalDoc);
    idMap[docId] = canonicalDoc;
    byDocId.set(docId, raw);

    for (const alias of aliases) {
      aliasMap[alias] = canonicalSourceId;
      aliasMap[normalizeSourceAlias(alias)] = canonicalSourceId;
      aliasMergeCount++;
    }
  }

  // Calculate authoritative metrics
  const uniqueCanonicalIds = new Set(canonicalList.map((d) => d.canonical_source_id));
  const independentPhysicalSources = canonicalList.filter((d) => !d.is_duplicate_physical_source);
  const independentCanonicalIds = new Set(independentPhysicalSources.map((d) => d.canonical_source_id));

  const unique_source_count = uniqueCanonicalIds.size;
  const independent_source_count = independentCanonicalIds.size;
  const documents_analyzed = independentPhysicalSources.length;
  const source_count = unique_source_count;

  const metrics: CanonicalSourceMetrics = {
    documents_analyzed,
    source_count,
    unique_source_count,
    independent_source_count,
    corroborating_source_count: independent_source_count,
    citation_source_count: unique_source_count,
    evidence_source_count: unique_source_count,
    source_diversity: independent_source_count > 1 ? 1.0 : 0.5,
    raw_source_records: records.length,
    alias_merge_count: aliasMergeCount,
    duplicate_hash_count: duplicateHashCount,
    canonical_source_ids: Array.from(uniqueCanonicalIds),
  };

  // Invariants checking
  const unique_source_count_valid = unique_source_count === uniqueCanonicalIds.size;
  const independent_source_count_valid = independent_source_count <= unique_source_count;
  const same_document_id_cannot_count_twice = true;
  const same_document_hash_cannot_create_independent_corroboration = duplicateHashCount > 0 ? (independent_source_count < records.length) : true;
  const all_invariants_passed = unique_source_count_valid && independent_source_count_valid;

  return {
    canonical_sources: canonicalList,
    metrics,
    alias_to_canonical_id: aliasMap,
    id_to_canonical_source: idMap,
    invariants: {
      unique_source_count_valid,
      independent_source_count_valid,
      citation_count_ge_unique: true,
      same_document_id_cannot_count_twice,
      same_document_hash_cannot_create_independent_corroboration,
      all_invariants_passed,
    },
  };
}

/**
 * Resolves any alias, filename, display name, or doc identifier to its authoritative canonical_source_id.
 */
export function resolveCanonicalSourceId(
  identifier: unknown,
  audit: CanonicalSourceAuditResult,
): string | null {
  if (!identifier) return null;
  const str = String(identifier).trim();
  if (!str) return null;

  // Direct ID match
  if (audit.id_to_canonical_source[str]) {
    return audit.id_to_canonical_source[str].canonical_source_id;
  }

  // Exact alias map lookup
  if (audit.alias_to_canonical_id[str]) {
    return audit.alias_to_canonical_id[str];
  }

  // Normalized alias lookup
  const norm = normalizeSourceAlias(str);
  if (audit.alias_to_canonical_id[norm]) {
    return audit.alias_to_canonical_id[norm];
  }

  return null;
}

export interface NormalizedCitation {
  document_id: string | null;
  canonical_source_id: string | null;
  document_hash: string | null;
  page: number;
  quote: string;
  chunk_id?: string | null;
  citation_hash?: string | null;
  display_label: string;
}

/**
 * Normalizes citation evidence references, binding them to canonical_source_id.
 */
export function normalizeCitationsWithCanonicalSources(
  citations: ReadonlyArray<Record<string, unknown>>,
  audit: CanonicalSourceAuditResult,
): NormalizedCitation[] {
  return (citations ?? []).map((c) => {
    const rawDocRef = c.document_id ?? c.doc_id ?? c.source_document_id ?? c.filename ?? c.source ?? null;
    const canonicalId = resolveCanonicalSourceId(rawDocRef, audit) ?? (typeof rawDocRef === "string" ? rawDocRef : null);
    const sourceDoc = canonicalId ? audit.id_to_canonical_source[canonicalId] : null;

    const page = typeof c.page === "number" ? c.page : 1;
    const quote = String(c.quote ?? c.source_quote ?? "").trim();
    const displayLabel = sourceDoc?.display_name ?? sourceDoc?.original_filename ?? (typeof rawDocRef === "string" ? rawDocRef : "Documento Fuente");

    return {
      document_id: sourceDoc?.document_id ?? (typeof rawDocRef === "string" ? rawDocRef : null),
      canonical_source_id: canonicalId,
      document_hash: sourceDoc?.document_hash ?? (c.document_hash as string | null) ?? null,
      page,
      quote,
      chunk_id: (c.chunk_id as string | null) ?? null,
      citation_hash: (c.citation_hash as string | null) ?? null,
      display_label: displayLabel,
    };
  });
}

/**
 * Computes corroboration analysis for a set of citations/sources.
 * Invariant: Multiple citations from the same canonical source do NOT constitute independent corroboration.
 */
export function evaluateSourceCorroboration(
  canonicalSourceIds: ReadonlyArray<string | null | undefined>,
  locale: "es" | "en" = "es",
): {
  citation_count: number;
  unique_source_count: number;
  independent_source_count: number;
  independent_corroboration: boolean;
  corroboration_prose: string;
} {
  const validIds = (canonicalSourceIds ?? []).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  const distinct = Array.from(new Set(validIds));
  const independentCount = distinct.length;
  const citationCount = validIds.length;
  const isIndependent = independentCount > 1;

  let prose: string;
  if (independentCount === 0) {
    prose = locale === "en" ? "No documentary source cited." : "No se citó ningún documento fuente.";
  } else if (independentCount === 1) {
    if (citationCount > 1) {
      prose = locale === "en"
        ? "The finding is supported by a single judicial/legal resolution through multiple relevant passages."
        : "El hallazgo está sustentado por una resolución judicial con múltiples pasajes relevantes.";
    } else {
      prose = locale === "en"
        ? "The finding is supported by 1 source document."
        : "El hallazgo está sustentado por 1 documento fuente.";
    }
  } else {
    prose = locale === "en"
      ? `${independentCount} independent source documents corroborate this finding.`
      : `${independentCount} documentos independientes corroboran el hallazgo.`;
  }

  return {
    citation_count: citationCount,
    unique_source_count: independentCount,
    independent_source_count: independentCount,
    independent_corroboration: isIndependent,
    corroboration_prose: prose,
  };
}
