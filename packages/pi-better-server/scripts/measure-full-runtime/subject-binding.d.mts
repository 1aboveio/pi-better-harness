export interface SubjectBinding { checkout: string; artifactRoot: string; driverCheckout: string }
export function subjectModuleUrl(url: string, binding: SubjectBinding): string;
export function parseSubjectBinding(value: string): SubjectBinding;
