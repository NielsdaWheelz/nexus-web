--
-- PostgreSQL database dump
--


-- Dumped from database version 15.19 (Debian 15.19-1.pgdg12+2)
-- Dumped by pg_dump version 15.19 (Debian 15.19-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.users VALUES ('00000000-0000-0000-0000-000000000000', '2026-09-21 06:19:51.781384+00', NULL, NULL, 'UTC', 1);


--
-- Data for Name: background_job_capacity_leases; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.background_job_capacity_leases VALUES ('Heavy', NULL, NULL, '2026-10-19 03:33:57.952487+00');


--
-- Data for Name: suggestion_inputs; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.suggestion_inputs VALUES ('01a15239-247d-71d4-9da1-7fc5cda43601', '2026-10-19 03:33:57.952487+00', 0);


--
-- Name: collection_order_revision_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.collection_order_revision_seq', 1, true);


--
-- Name: project_gutenberg_catalog_ebook_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_gutenberg_catalog_ebook_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--


