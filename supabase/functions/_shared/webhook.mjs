const MAX_SECRET_BYTES=256;

export function constantTimeSecretEqual(expected,supplied){
 const encoder=new TextEncoder();
 const a=encoder.encode(String(expected??''));
 const b=encoder.encode(String(supplied??''));
 const left=new Uint8Array(MAX_SECRET_BYTES);
 const right=new Uint8Array(MAX_SECRET_BYTES);
 left.set(a.subarray(0,MAX_SECRET_BYTES));
 right.set(b.subarray(0,MAX_SECRET_BYTES));
 let diff=a.length^b.length;
 for(let i=0;i<MAX_SECRET_BYTES;i++)diff|=left[i]^right[i];
 return a.length>0&&b.length>0&&a.length<=MAX_SECRET_BYTES&&b.length<=MAX_SECRET_BYTES&&diff===0;
}

export function isChargeCompletedEvent(event){
 return event?.event==='charge.completed'&&typeof event?.data?.tx_ref==='string'&&event.data.tx_ref.length>0;
}

export function webhookRequestStatus(expected,supplied,event){
 if(!constantTimeSecretEqual(expected,supplied))return 401;
 if(!isChargeCompletedEvent(event))return 400;
 return 200;
}
