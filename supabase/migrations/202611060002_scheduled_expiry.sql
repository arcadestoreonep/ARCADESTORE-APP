-- Reservation and payment hold release run server-side even if a buyer closes the app.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('arcadestore-expire-reservations','* * * * *','select public.expire_reservations()');
select cron.schedule('arcadestore-expire-payment-holds','* * * * *','select public.expire_orders()');
