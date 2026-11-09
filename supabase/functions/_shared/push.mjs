export const PUSH_TYPES = Object.freeze(['instant_sale','assisted_delivery','chat_message','rental_started','rental_expiring','rental_expired']);

export function pushRecipients(eventType, order, actorId, ownerId) {
  const vendorIds = [...new Set((order.order_items || []).map(item => item.owner_vendor_id || (item.owner_type === 'vendor' ? item.seller_id : null)).filter(Boolean))];
  if (eventType === 'chat_message') {
    const participants = [order.buyer_id, ...vendorIds];
    if (order.support_thread) participants.push(ownerId);
    return [...new Set(participants)].filter(id => id && id !== actorId);
  }
  if (eventType === 'instant_sale') {
    const recipients = [...vendorIds];
    if ((order.order_items || []).some(item => item.owner_type !== 'vendor')) recipients.push(ownerId);
    return [...new Set(recipients)].filter(Boolean);
  }
  if (['assisted_delivery','rental_started','rental_expiring','rental_expired'].includes(eventType)) {
    return [...new Set([...vendorIds, ownerId])].filter(Boolean);
  }
  return [];
}

export function pushCopy(eventType, order, item = {}) {
  const orderLabel = order.order_code || order.id;
  const listingLabel = item.listing_code || item.listing_id || 'listing';
  if (eventType === 'instant_sale') return {title:'New instant sale', body:`New instant sale: ${listingLabel} · Order ${orderLabel} · ₦${Number(item.gross || 0).toLocaleString('en-NG')}`};
  if (eventType === 'assisted_delivery') return {title:'Assisted delivery paid', body:`Assisted delivery paid: Order ${orderLabel} · Listing ${listingLabel}`};
  if (eventType === 'chat_message') return {title:'New order message', body:`New message on Order ${orderLabel}`};
  if (eventType === 'rental_started') return {title:'Rental started', body:`Rental started: Order ${orderLabel} · Listing ${listingLabel}`};
  if (eventType === 'rental_expiring') return {title:'Rental ending soon', body:`Rental expiring soon: Order ${orderLabel} · Listing ${listingLabel}`};
  if (eventType === 'rental_expired') return {title:'Rental expired', body:`Rental expired: Order ${orderLabel} · Listing ${listingLabel}`};
  return null;
}

export function pushTarget(orderId, chat = false, recipientRole = 'buyer', eventType = 'chat_message') {
  const screen=recipientRole==='owner'||recipientRole==='admin'?'Admin':recipientRole==='vendor'?'Vendor':'Orders';
  const query = new URLSearchParams({screen,order_id:String(orderId)});
  if(screen==='Admin')query.set('admin_tab',eventType==='instant_sale'?'Sales':'Orders');
  if(screen==='Vendor')query.set('vendor_tab','Orders');
  if (chat) query.set('open_chat','1');
  return `./?${query}`;
}
