export interface JobSite {label:string;latitude:number;longitude:number}
export interface TechnicianProfile {
  timezone:string;
  skills:string[];
  workingHours:{weekday:number;start:string;end:string}[];
  timeOff:{start:string;end:string}[];
  base:JobSite|null;
}
export interface TechnicianPlanning {
  personId:string;displayName:string;branchId:string;version:number;profile:TechnicianProfile|null;
}
export interface TravelEstimate {
  minutes:number|null;source:'OSRM'|'unknown';checkedAt:string;
}
export interface TechnicianCandidate {
  personId:string;displayName:string;profileVersion:number;
  status:'available'|'blocked'|'needs_check';
  reasons:string[];
  travel:{direction:'before'|'after';from:string;to:string;minutes:number|null;source:string}[];
}
export interface TechnicianMatches {
  jobId:string;jobVersion:number;scheduledAt:string|null;estimatedMinutes:number|null;
  checkedAt:string;candidates:TechnicianCandidate[];
}
