import type {AgentLoopFinalResponseGuard} from '@agent-native/core/server';
const writes=new Set(['create-work-commitment','add-relay-job-update','reschedule-relay-visit','update-relay-client-deadline','update-relay-job','apply-relay-assignment']);
export const relayReplyGuard:AgentLoopFinalResponseGuard=({toolResults,text,receipts})=>{
 const attempts=toolResults.filter(result=>writes.has(result.name));
 const last=attempts[attempts.length-1];
 let receipt=last?.receipt;
 if(!receipt&&last?.content){try{receipt=JSON.parse(last.content)._receipt;}catch{/* Plain Native approval/validation messages carry no receipt. */}}
 if(!receipt){const latest=(receipts??[]).filter(item=>writes.has(item.tool)&&(!last||item.tool===last.name));receipt=latest[latest.length-1];}
 // Only a verified write receipt can establish a completed change. A successful read or
 // an approval request is not a save. Summarize the receipt, never the pre-change snapshot.
 if(last?.isError||(receipt&&(!receipt.changed||receipt.verified!==true))||(last&&!receipt))return {
  retryMessage:'The requested write did not return a verified save. Do not claim success, request imaginary approval, or repeat the write.',
  maxRetries:0,clearAllText:true,fallbackMessage:receipt?.summary??'The change was not confirmed in Relay. Check the failed action details before trying again.',
 };
 const unresolvedFailure=attempts.some((attempt,index)=>attempt.isError&&!attempts.slice(index+1).some(later=>later.name===attempt.name&&!later.isError&&(later.receipt?.verified===true||(()=>{try{return JSON.parse(later.content)._receipt?.verified===true;}catch{return false;}})())));
 if(unresolvedFailure&&receipt?.changed&&receipt.verified===true)return {
  retryMessage:'One action succeeded but another requested change failed. Report the partial outcome, not overall success.',maxRetries:0,clearAllText:true,
  fallbackMessage:receipt.summary+' Another requested change was not confirmed. Check the failed action details before trying again.',
 };
 if(receipt?.changed&&receipt.verified===true&&receipt.summary&&text?.trim()!==receipt.summary)return {
  retryMessage:'Report only the verified write receipt, including its saved local date/time. Do not quote the old schedule or repeat the write.',
  maxRetries:0,clearAllText:true,fallbackMessage:receipt.summary,
 };
 if(!attempts.length&&!receipt&&/\b(?:the approved action has run|I(?:['’]ve| have)? (?:moved|rescheduled|scheduled|changed|updated))\b/i.test(text??''))return {
  retryMessage:'No verified write ran. Use the matching Native action before claiming a change. For a visit date change use reschedule-relay-visit; if required information is missing, ask for it.',
  maxRetries:1,clearAllText:true,fallbackMessage:'No change was saved in this turn. Relay needs a real approved action before it can change the job.',
 };
 const claimsSavedUpdate=/\b(?:I(?:['’]ve| have)?\s+(?:(?:successfully|now)\s+)?(?:recorded|saved|added)\b|(?:job update|confirmation(?: note)?|update|note)\s+(?:is|was|has been|has now been)\s+(?:successfully\s+)?(?:recorded|saved|added)\b)/i.test(text??'');
 const describesExisting=/\b(?:already (?:recorded|saved|added)|(?:existing|previous|earlier) (?:job )?(?:update|note|record)|history shows?)\b/i.test(text??'');
 if(!attempts.length&&claimsSavedUpdate&&!describesExisting)return {
  retryMessage:'Your draft claims a newly saved update, but no write action ran. A new save requires add-relay-job-update. Call that action now with jobId and expectedVersion from current-screen.record.job and the client-provided confirmation as note. Native will request approval before saving. Do not return another completion sentence without the action. If you were only describing an existing history entry, clearly say it already existed.',
  maxRetries:1,clearAllText:true,fallbackMessage:'No new job update was saved in this turn.',
 };
 if(!attempts.length&&/\b(?:I(?:'|’)ll|I will|I am going to)\b.{0,100}\b(?:add|create|save|update|schedule|assign|record)\b/i.test(text??''))return {
  retryMessage:'You promised an app modification but have not called its action. Use current records to call the appropriate write action now. Do not stop at describing the modification. Native will ask for approval.',
  maxRetries:1,clearAllText:true,fallbackMessage:'I have not saved a change. No write action was completed. Please try again or make this change in the job page.',
 };

 if(/^\s*(?:[\[{]|```(?:json)?)/.test(text??'')){
  const verified=(receipts??[]).filter(r=>r.changed&&r.verified===true);
  const summary=receipt?.changed&&receipt.verified===true?receipt.summary:verified[verified.length-1]?.summary;
  return {retryMessage:'Answer the current request in plain English, not JSON. If an approved write ran, summarize its verified receipt and dueAtLabel in two short sentences. Otherwise state the requested facts directly. Do not perform another change.',maxRetries:2,clearAllText:true,fallbackMessage:summary??'I retrieved the records but could not produce a clear answer. Please ask again.'};
 }

};
