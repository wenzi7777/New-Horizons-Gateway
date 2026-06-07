import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.result_chunks import ResultChunkReassembler  # noqa: E402


def split_result(response: str, *, chunk_raw: int, request_id: str, device_uid: str) -> list[dict]:
    total = (len(response) + chunk_raw - 1) // chunk_raw
    frames = []
    for i in range(total):
        frames.append(
            {
                "type": "result_chunk",
                "device_uid": device_uid,
                "request_id": request_id,
                "chunk": i,
                "chunks": total,
                "data": response[i * chunk_raw : (i + 1) * chunk_raw],
            }
        )
    return frames


class ResultChunkReassemblerTest(unittest.TestCase):
    def test_reassembles_in_order_chunks_into_full_result_frame(self):
        clock = [0.0]
        reasm = ResultChunkReassembler(ttl_sec=10.0, now=lambda: clock[0])
        response = json.dumps({"ok": True, "cmd": "status", "data": {"matrix_shape": {"rows": 3, "cols": 3}, "x": "y" * 500}})
        frames = split_result(response, chunk_raw=120, request_id="req-1", device_uid="3CDC7545CCD0")
        self.assertGreater(len(frames), 1)

        result = None
        for frame in frames:
            result = reasm.add(frame)
        self.assertIsNotNone(result)
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["device_uid"], "3CDC7545CCD0")
        self.assertEqual(result["request_id"], "req-1")
        self.assertEqual(result["payload"]["cmd"], "status")
        self.assertEqual(result["payload"]["data"]["matrix_shape"], {"rows": 3, "cols": 3})

    def test_returns_none_until_all_chunks_received(self):
        reasm = ResultChunkReassembler()
        response = json.dumps({"ok": True, "data": "z" * 400})
        frames = split_result(response, chunk_raw=100, request_id="req-2", device_uid="DEV")
        for frame in frames[:-1]:
            self.assertIsNone(reasm.add(frame))
        self.assertIsNotNone(reasm.add(frames[-1]))

    def test_reassembles_out_of_order_chunks(self):
        reasm = ResultChunkReassembler()
        response = json.dumps({"ok": True, "data": "abc" * 300})
        frames = split_result(response, chunk_raw=90, request_id="req-3", device_uid="DEV")
        result = None
        for frame in reversed(frames):
            result = reasm.add(frame)
        self.assertIsNotNone(result)
        self.assertEqual(json.dumps(result["payload"]), response)

    def test_invalid_or_incomplete_json_returns_none(self):
        reasm = ResultChunkReassembler()
        # Single chunk whose data is not valid JSON once assembled.
        frame = {"type": "result_chunk", "device_uid": "DEV", "request_id": "req-4", "chunk": 0, "chunks": 1, "data": "{not json"}
        self.assertIsNone(reasm.add(frame))

    def test_expired_partial_buffers_are_purged(self):
        clock = [0.0]
        reasm = ResultChunkReassembler(ttl_sec=10.0, now=lambda: clock[0])
        response = json.dumps({"ok": True, "data": "q" * 300})
        frames = split_result(response, chunk_raw=80, request_id="req-5", device_uid="DEV")
        reasm.add(frames[0])
        self.assertEqual(reasm.pending_count(), 1)
        clock[0] = 11.0
        reasm.purge()
        self.assertEqual(reasm.pending_count(), 0)
        # A late remaining chunk after purge does not complete the old buffer.
        self.assertIsNone(reasm.add(frames[1]))

    def test_missing_request_id_or_bad_fields_returns_none(self):
        reasm = ResultChunkReassembler()
        self.assertIsNone(reasm.add({"type": "result_chunk", "chunk": 0, "chunks": 1, "data": "x"}))
        self.assertIsNone(reasm.add({"type": "result_chunk", "request_id": "r", "chunk": 0, "chunks": 0, "data": "x"}))


if __name__ == "__main__":
    unittest.main()
