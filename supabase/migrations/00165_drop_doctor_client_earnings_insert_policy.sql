-- Security fix: drop the RLS policy that allowed doctors to INSERT earnings
-- events directly from the client. All earnings events are created exclusively
-- by DB triggers (trg_record_earnings_event on credit_transactions) and
-- SECURITY DEFINER RPCs (recalculate_doctor_earnings, remove_student_and_record_earnings).
-- No client-side direct INSERT is valid or needed.
DROP POLICY IF EXISTS doctor_insert_own_dee ON doctor_earnings_events;