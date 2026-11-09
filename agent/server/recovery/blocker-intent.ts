export function blockerRequest(request:string){
 const text=request.trim();
 const requested=/^(?:please\s+)?(?:record|save|log|prepare|propose|revise|resume|clear|unblock|update)\b/i.test(text)||/\b(?:please|can you|could you)\s+(?:record|save|log|prepare|propose|revise|resume|clear|resolve|update)\b/i.test(text);
 if(!requested)return null;
 // This supplies a draft only. Clearing still requires explicit dispatcher approval.
 const wantsResume=/\b(?:resume (?:the )?work|clear (?:the )?blocker|unblock (?:the )?job)\b/i.test(text);
 const blockerCleared=/\b(?:part|fan|replacement)\b.{0,70}\b(?:has arrived|arrived|received|on site)\b|\bblocker (?:is |has been )?cleared\b/i.test(text)&&!/\b(?:not|hasn't|has not|haven't|have not|isn't|is not|will|expected|due to)\b.{0,20}\b(?:arriv|receiv|cleared)/i.test(text);
 const ready=/\b(?:can|ready to|able to) resume(?: work)?\b/i.test(text)&&!/\b(?:not|cannot|can't|isn't|is not|unable to)\b.{0,35}\b(?:ready|resume)\b/i.test(text);
 const hypothetical=/\b(?:if|once|when)\b.{0,80}\b(?:arriv|receiv|cleared|resume)/i.test(text);
 const cleared=blockerCleared&&ready&&!hypothetical;
 const hasFacts=/confirmed facts:\s*\S|(?:supplier|part|fan|eta|delivery|technician|blocker|access|client|repair|equipment).*(?:confirmed|arriv|deliver|ready|cleared|receiv|says|reported|waiting|fixed|restored|available|expected|not)/i.test(text);
 if(!cleared&&!hasFacts)return {needsFacts:true as const};
 return {needsFacts:false as const,mode:wantsResume&&cleared?'resume_work' as const:'record_update' as const,cleared:wantsResume&&cleared,note:(/confirmed facts:\s*([\s\S]*)/i.exec(text)?.[1]?.trim()??text)};
}
