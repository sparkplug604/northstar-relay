export function displayTime(instant:string,timezone='America/Vancouver'){
 const zone=workingTimezone(timezone,Date.parse(instant));
 return new Intl.DateTimeFormat('en-CA',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'shortOffset'}).format(new Date(instant));
}

export function workingTimezone(timezone:string,instant:number){
 // Match Relay's packaged B.C. rules; the host ICU still has the old fallback.
 return timezone==='America/Vancouver'&&instant>=Date.parse('2026-03-08T10:00:00Z')?'Etc/GMT+7':timezone;
}


function localParts(instant:number,timezone:string){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:workingTimezone(timezone,instant),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
 return Object.fromEntries(parts.map(part=>[part.type,part.value]));
}
/** Interpret a dispatcher calendar date in the branch timezone, preserving the visit clock time. */
export function visitInstant(date:string,time:string|undefined,previous:string|null,timezone:string){
 const clock=time??(previous?(()=>{const p=localParts(Date.parse(previous),timezone);return p.hour+':'+p.minute;})():null);
 if(!clock)throw Error('What time should the visit start? No existing visit time is saved.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))throw Error('Use a calendar date YYYY-MM-DD and local time HH:mm.');
 const desired=Date.parse(date+'T'+clock+':00Z');
 if(!Number.isFinite(desired)||new Date(desired).toISOString().slice(0,10)!==date)throw Error('That calendar date does not exist.');
 let guess=desired;
 for(let i=0;i<4;i++){const p=localParts(guess,timezone);const wall=Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':00Z');const correction=desired-wall;if(!correction)break;guess+=correction;}
 const matches=(instant:number)=>{const p=localParts(instant,timezone);return p.year+'-'+p.month+'-'+p.day===date&&p.hour+':'+p.minute===clock;};
 if(!matches(guess))throw Error('That local time does not exist because the clocks change. Choose another time.');
 if(matches(guess-3600000)||matches(guess+3600000))throw Error('That local time occurs twice because the clocks change. Please choose an unambiguous time.');
 return new Date(guess).toISOString();
}
