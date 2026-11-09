-- Keep rental availability accurate even when no buyer or vendor has the app open.
select cron.schedule('arcadestore-expire-rentals','* * * * *','select public.expire_rentals()');
