
-- Enable Realtime on profiles so clients receive security_version changes instantly
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;

-- Also enable on devices so trust_level=revoked is detected in real-time
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
