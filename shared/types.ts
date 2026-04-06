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

export interface UserInfo {
  login: string;
  avatarUrl: string;
  name: string | null;
}

export interface AuthError {
  error: string;
  message: string;
}

export interface RepoInfo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
  htmlUrl: string;
}

export interface BranchInfo {
  name: string;
  commit: string;
  protected: boolean;
}

export interface ReposResponse {
  repos: RepoInfo[];
  page: number;
  perPage: number;
  hasNextPage: boolean;
}

export interface BranchesResponse {
  branches: BranchInfo[];
}
