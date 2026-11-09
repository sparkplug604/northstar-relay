import {splitAgentKitMessageContext} from '@agent-native/agentkit/chat-context';
export function dispatcherText(value:string){
 let text=value;
 // sendToAgentChat and the chat surface may each append a context envelope.
 // Strip those with the framework parser; they are not dispatcher-provided facts.
 for(let count=0;count<5&&text.includes('<context data-agentkit-context-encoding="entities-v1">');count++){
  const next=splitAgentKitMessageContext(text).message;if(next===text)break;text=next;
 }
 return text.trim();
}
