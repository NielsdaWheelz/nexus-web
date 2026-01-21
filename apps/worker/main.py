"""Thin worker launcher (placeholder).

This will be the Celery entrypoint. All task logic lives in nexus.jobs.
Run with: celery -A main worker --loglevel=info
"""

# TODO: Implement in future PR when worker is needed
# from celery import Celery
# from nexus.jobs import register_tasks
#
# app = Celery('nexus')
# register_tasks(app)
