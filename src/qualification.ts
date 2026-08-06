export interface ProjectSpec {
  project_name?: string;
  client_name?: string;
  location?: string;
  region?: string;
  start_date?: string;
  end_date?: string;
  scope?: string;
  materials?: string[];
  labor?: string[];
  constraints?: string[];
}

export interface QualificationRules {
  required_fields: string[];
  min_materials?: number;
  min_labor?: number;
  reject_threshold: number;
  clarify_threshold: number;
  field_weights?: Record<string, number>;
}

export interface RouteResult {
  action: "proceed" | "clarify" | "reject";
  score: number;
  reasons: string[];
  missing_fields: string[];
}

function getField(spec: ProjectSpec, field: string): unknown {
  return (spec as Record<string, unknown>)[field];
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Score a project spec and route it to proceed, clarify, or reject.
 * Score is the percentage of required fields present, weighted by field_weights.
 */
export function qualify(spec: ProjectSpec, rules: QualificationRules): RouteResult {
  const missingFields: string[] = [];
  const reasons: string[] = [];
  let presentWeight = 0;
  let totalWeight = 0;

  const weights = rules.field_weights ?? {};
  const defaultWeight = 1;

  for (const field of rules.required_fields) {
    const weight = weights[field] ?? defaultWeight;
    totalWeight += weight;
    const value = getField(spec, field);
    if (isPresent(value)) {
      presentWeight += weight;
    } else {
      missingFields.push(field);
    }
  }

  if (rules.min_materials !== undefined) {
    totalWeight += 1;
    const materials = Array.isArray(spec.materials) ? spec.materials : [];
    if (materials.length >= rules.min_materials) {
      presentWeight += 1;
    } else {
      missingFields.push("materials_count");
      reasons.push(`At least ${rules.min_materials} materials are required`);
    }
  }

  if (rules.min_labor !== undefined) {
    totalWeight += 1;
    const labor = Array.isArray(spec.labor) ? spec.labor : [];
    if (labor.length >= rules.min_labor) {
      presentWeight += 1;
    } else {
      missingFields.push("labor_count");
      reasons.push(`At least ${rules.min_labor} labor items are required`);
    }
  }

  const score = totalWeight === 0 ? 100 : Math.round((presentWeight / totalWeight) * 100);

  if (missingFields.length > 0) {
    reasons.push(`Missing fields: ${missingFields.join(", ")}`);
  }

  let action: RouteResult["action"];
  if (score < rules.reject_threshold) {
    action = "reject";
  } else if (score < rules.clarify_threshold) {
    action = "clarify";
  } else {
    action = "proceed";
  }

  return { action, score, reasons, missing_fields: missingFields };
}
