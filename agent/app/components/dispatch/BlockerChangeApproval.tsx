import {useEffect,useRef,useState} from 'react';
import {useActionMutation,useActionQuery} from '@agent-native/core/client/hooks';
import {registerActionChatRenderer,type ToolRendererProps} from '@agent-native/toolkit/app/chat';
import {Button} from '@/components/ui/button';
import type {BlockerWorkflow} from '../../../server/recovery/blocker.js';
type Review={jobId:string;revision:number;proposal:NonNullable<BlockerWorkflow['proposal']>};
function BlockerChangeApproval({context}:ToolRendererProps){
 // The shared chat also renders a work-timeline preview of this tool.
 // Keep the confirmation in its durable conversation widget only.
 if(context.isActiveTail!==undefined)return null;
 const result=context.resultJson as Partial<Review>|null;
 if(context.isRunning)return <p role="status">Preparing the update…</p>;
 if(!result?.jobId||!result.revision||!result.proposal)return null;
 return <ReviewedChange key={result.proposal.key} review={result as Review}/>;
}
function ReviewedChange({review}:{review:Review}){
 const read=useActionQuery('read-blocker-workflow',{jobId:review.jobId});
 const approve=useActionMutation('approve-blocker-update');
 const state=read.data as BlockerWorkflow|undefined;
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const posted=useRef(false);
 const same=state?.proposal?.key===review.proposal.key;
 const receipt=same&&state?.receipt;
 const claimed=same&&state?.proposal?.state==='applying'&&state.revision===review.revision+1;
 const stale=state&&(!same||!receipt&&(state.job.version!==review.proposal.jobVersion||state.revision!==review.revision&&!claimed));
 useEffect(()=>{if(receipt&&!posted.current){posted.current=true;window.parent.postMessage({type:'relay-job-updated',jobId:review.jobId},'http://127.0.0.1:3004');}},[receipt,review.jobId]);
 async function apply(){
  if(busy||stale||receipt)return;setBusy(true);setError('');
  try{const result=await approve.mutateAsync({jobId:review.jobId,revision:review.revision}) as BlockerWorkflow;if(!result.receipt)throw Error('The history receipt is not available yet. Retry saving this change.');}
  catch(error){setError(error instanceof Error?error.message:String(error));}
  finally{await read.refetch();setBusy(false);}
 }
 if(receipt)return <p role="status">Saved to Relay job history. {state.job.status==='blocked'?'The job is still blocked.':'Current status: '+state.job.status.replace(/_/g,' ')+'.'}</p>;
 return <div className="dispatch-blocker-confirmation" role="group" aria-label="Confirm blocker update" aria-busy={busy}>
  <p><strong>{review.proposal.mode==='resume_work'?'Clear blocker and resume work':'Record update; keep blocked'}</strong></p>
  <p>{review.proposal.note}</p>
  {stale?<p role="status">This draft changed or the job was updated. Ask Relay to prepare a fresh change.</p>:<Button size="sm" disabled={busy||!state||Boolean(read.error)} onClick={()=>void apply()}>{busy?'Saving…':claimed?'Retry saving approved change':review.proposal.mode==='resume_work'?'Approve and resume work':'Approve and save update'}</Button>}
  {read.error&&<p role="alert">Could not check this draft. <Button size="sm" variant="outline" onClick={()=>void read.refetch()}>Retry</Button></p>}
  {error&&!receipt&&<p role="alert">{error}</p>}
 </div>;
}
const unregister=registerActionChatRenderer({id:'relay-blocker-change',renderer:'relay.blocker-change',Component:BlockerChangeApproval});
if(import.meta.hot)import.meta.hot.dispose(unregister);
