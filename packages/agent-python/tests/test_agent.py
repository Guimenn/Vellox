import unittest
from vellox.agent import VelloxAgent
from vellox.middleware.fastapi import normalize_route
from vellox.integrations.sqlalchemy import fingerprint_sql


class TestVelloxPythonAgent(unittest.TestCase):
    def test_route_normalization(self):
        self.assertEqual(normalize_route("/api/v1/users/12345"), "/api/v1/users/:id")
        self.assertEqual(
            normalize_route("/api/v1/orders/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"),
            "/api/v1/orders/:uuid",
        )
        self.assertEqual(
            normalize_route("/catalog/64b5f928e13f48a902345678"),
            "/catalog/:objectId",
        )

    def test_sql_fingerprinting(self):
        sql = "SELECT * FROM users WHERE id = 42 AND email = 'test@example.com'"
        fp = fingerprint_sql(sql)
        self.assertEqual(fp, "SELECT * FROM users WHERE id = ? AND email = ?")

    def test_agent_recording_and_buffering(self):
        agent = VelloxAgent(service_name="test-py-svc", flush_interval_seconds=60.0)
        agent.record_http({
            "route": "/api/v1/health",
            "method": "GET",
            "statusCode": 200,
            "durationMs": 1.5,
        })
        agent.record_database({
            "databaseType": "postgresql",
            "operation": "SELECT",
            "fingerprint": "SELECT * FROM users WHERE id = ?",
            "totalDurationMs": 2.1,
            "executionCount": 1,
        })

        self.assertEqual(len(agent._http_buffer), 1)
        self.assertEqual(len(agent._db_buffer), 1)

        # Test flush gracefully handles offline collector without raising exception
        agent.flush()
        self.assertEqual(len(agent._http_buffer), 0)
        self.assertEqual(len(agent._db_buffer), 0)


if __name__ == "__main__":
    unittest.main()
