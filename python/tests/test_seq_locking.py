"""Tests for message sequence assignment with row-level locking.

These tests verify that the seq assignment helper correctly handles
concurrent access using FOR UPDATE locks.

Per S3 spec:
- Seq assignment locks the conversation row
- Concurrent sessions must block until the lock is released
- Seq values are strictly increasing and unique per conversation
"""

import threading
import time
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.seq import assign_next_message_seq


class TestSeqAssignmentBasic:
    """Basic tests for sequence assignment."""

    def test_first_seq_is_1(self, db_session: Session):
        """First assigned seq should be 1 (default next_seq)."""
        # Create user and conversation
        user_id = uuid4()
        conversation_id = uuid4()

        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                VALUES (:id, :user_id, 'private', 1)
            """),
            {"id": conversation_id, "user_id": user_id},
        )
        db_session.flush()

        # Assign first seq
        seq = assign_next_message_seq(db_session, conversation_id)

        assert seq == 1

        # Verify next_seq was incremented
        result = db_session.execute(
            text("SELECT next_seq FROM conversations WHERE id = :id"),
            {"id": conversation_id},
        )
        assert result.scalar() == 2

    def test_sequential_assignment(self, db_session: Session):
        """Sequential assignments return consecutive seq values."""
        user_id = uuid4()
        conversation_id = uuid4()

        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                VALUES (:id, :user_id, 'private', 1)
            """),
            {"id": conversation_id, "user_id": user_id},
        )
        db_session.flush()

        # Assign multiple seqs
        seq1 = assign_next_message_seq(db_session, conversation_id)
        seq2 = assign_next_message_seq(db_session, conversation_id)
        seq3 = assign_next_message_seq(db_session, conversation_id)

        assert seq1 == 1
        assert seq2 == 2
        assert seq3 == 3

    def test_nonexistent_conversation_raises(self, db_session: Session):
        """Assigning seq for nonexistent conversation raises ValueError."""
        nonexistent_id = uuid4()

        with pytest.raises(ValueError) as exc_info:
            assign_next_message_seq(db_session, nonexistent_id)

        assert str(nonexistent_id) in str(exc_info.value)
        assert "not found" in str(exc_info.value)


class TestSeqConcurrency:
    """Concurrency tests for sequence assignment using direct database access."""

    def test_concurrent_assignment_no_duplicates(self, direct_db):
        """Concurrent seq assignments must produce unique, consecutive values.

        This test uses two separate database connections to verify that
        FOR UPDATE locking prevents race conditions.
        """
        # Setup: create user and conversation
        user_id = uuid4()
        conversation_id = uuid4()
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as s:
            s.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            s.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 1)
                """),
                {"id": conversation_id, "user_id": user_id},
            )
            s.commit()

        # Track results from each thread
        results: dict[str, int | None | Exception] = {}
        barrier = threading.Barrier(2)  # Synchronize thread start

        def assign_in_thread(thread_name: str, hold_lock_for: float = 0):
            """Thread function that assigns a seq."""
            try:
                barrier.wait(timeout=5)  # Sync start
                with direct_db.session() as s:
                    # Begin transaction explicitly
                    seq = assign_next_message_seq(s, conversation_id)
                    if hold_lock_for > 0:
                        time.sleep(hold_lock_for)
                    s.commit()
                    results[thread_name] = seq
            except Exception as e:
                results[thread_name] = e

        # Thread A holds the lock briefly
        thread_a = threading.Thread(target=assign_in_thread, args=("A", 0.1), daemon=True)
        # Thread B tries to acquire the lock
        thread_b = threading.Thread(target=assign_in_thread, args=("B", 0), daemon=True)

        thread_a.start()
        thread_b.start()

        thread_a.join(timeout=5)
        thread_b.join(timeout=5)

        # Both threads should succeed
        assert isinstance(results.get("A"), int), f"Thread A failed: {results.get('A')}"
        assert isinstance(results.get("B"), int), f"Thread B failed: {results.get('B')}"

        # Seqs should be consecutive and unique
        seq_a = results["A"]
        seq_b = results["B"]
        assert {seq_a, seq_b} == {1, 2}, f"Expected {{1, 2}}, got {{{seq_a}, {seq_b}}}"

    def test_blocking_behavior(self, direct_db):
        """Session B must block while Session A holds the FOR UPDATE lock.

        This test verifies the actual blocking behavior of FOR UPDATE.
        """
        user_id = uuid4()
        conversation_id = uuid4()
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as s:
            s.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            s.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 1)
                """),
                {"id": conversation_id, "user_id": user_id},
            )
            s.commit()

        # Timeline tracking
        events: list[tuple[str, float]] = []
        start_time = time.time()

        def record_event(name: str):
            events.append((name, time.time() - start_time))

        lock_acquired = threading.Event()
        proceed_to_commit = threading.Event()

        def session_a():
            """Session A: acquire lock, hold it, then commit."""
            with direct_db.session() as s:
                # Acquire FOR UPDATE lock
                s.execute(
                    text("""
                        SELECT next_seq FROM conversations
                        WHERE id = :id FOR UPDATE
                    """),
                    {"id": conversation_id},
                )
                record_event("A_acquired_lock")
                lock_acquired.set()

                # Hold the lock until signaled
                proceed_to_commit.wait(timeout=5)
                record_event("A_releasing_lock")

                # Update and commit
                s.execute(
                    text("""
                        UPDATE conversations SET next_seq = next_seq + 1
                        WHERE id = :id
                    """),
                    {"id": conversation_id},
                )
                s.commit()
                record_event("A_committed")

        def session_b():
            """Session B: wait for A to acquire lock, then try to acquire."""
            lock_acquired.wait(timeout=5)  # Wait for A to hold the lock
            time.sleep(0.05)  # Small delay to ensure A is holding

            record_event("B_attempting_lock")
            with direct_db.session() as s:
                # This should block until A releases
                s.execute(
                    text("""
                        SELECT next_seq FROM conversations
                        WHERE id = :id FOR UPDATE
                    """),
                    {"id": conversation_id},
                )
                record_event("B_acquired_lock")
                s.commit()

        # Start both threads
        thread_a = threading.Thread(target=session_a, daemon=True)
        thread_b = threading.Thread(target=session_b, daemon=True)

        thread_a.start()
        thread_b.start()

        # Wait for B to attempt the lock
        time.sleep(0.2)

        # Let A release the lock
        proceed_to_commit.set()

        thread_a.join(timeout=5)
        thread_b.join(timeout=5)

        # Verify event ordering
        event_names = [e[0] for e in events]
        assert "A_acquired_lock" in event_names
        assert "B_attempting_lock" in event_names
        assert "B_acquired_lock" in event_names

        # B must acquire lock AFTER A released it
        a_released_idx = event_names.index("A_releasing_lock")
        b_acquired_idx = event_names.index("B_acquired_lock")
        assert b_acquired_idx > a_released_idx, f"B acquired lock before A released: {events}"
