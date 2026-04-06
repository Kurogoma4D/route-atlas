export interface AnalysisResult {
  framework: string;
  screens: Screen[];
  transitions: Transition[];
}

export interface Screen {
  id: string;
  path: string;
  componentFile: string;
  label: string;
  description: string;
  variants: Variant[];
}

export interface Variant {
  id: string;
  label: string;
  condition: string;
  type: VariantType;
}

export type VariantType =
  | "loading"
  | "error"
  | "empty"
  | "auth_required"
  | "permission"
  | "responsive"
  | "conditional";

export interface Transition {
  id: string;
  from: string;
  to: string;
  trigger: string;
  method: string;
  condition?: string;
}
