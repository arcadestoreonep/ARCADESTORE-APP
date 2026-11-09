import {env} from './server.ts';

export async function sendPush(event:Record<string,unknown>) {
  const url=env('SUPABASE_URL');
  const key=env('SUPABASE_SERVICE_ROLE_KEY');
  let response:Response;
  try{response=await fetch(`${url}/functions/v1/send-push`,{
    method:'POST',
    headers:{Authorization:`Bearer ${key}`,apikey:key,'Content-Type':'application/json'},
    body:JSON.stringify(event),
  });}catch{console.error('[push] delivery request failed',{event_type:event.event_type});return;}
  if(!response.ok) console.error('[push] delivery request failed',{status:response.status,event_type:event.event_type});
}
