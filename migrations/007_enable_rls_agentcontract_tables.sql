-- @target postgres

ALTER TABLE public.agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cli_login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agentcontract_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cli_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
