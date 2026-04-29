# tests/test_file_processor.py
from openagenticskyzer.app.file_processor import process_upload, build_message_content
from openagenticskyzer.app.state import AttachedFile


class TestProcessUpload:

    def test_text_file(self):
        result = process_upload("hello.py", b"def foo(): pass")
        assert result is not None
        assert result.content_type == "text"
        assert "def foo" in result.content
        assert result.name == "hello.py"

    def test_unsupported_extension_returns_none(self):
        result = process_upload("file.exe", b"\x00\x01\x02")
        assert result is None

    def test_csv_file(self):
        csv_bytes = b"name,age\nAlice,30\nBob,25"
        result = process_upload("data.csv", csv_bytes)
        assert result is not None
        assert result.content_type == "csv"
        assert "Alice" in result.content

    def test_large_text_truncated(self):
        big = b"x" * 60_000
        result = process_upload("big.txt", big)
        assert result is not None
        assert len(result.content) <= 50_001

    def test_image_returns_data_uri(self):
        png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
        result = process_upload("img.png", png_header)
        assert result is not None
        assert result.content_type == "image"
        assert result.content.startswith("data:image/png;base64,")


class TestBuildMessageContent:

    def test_no_files_returns_string(self):
        result = build_message_content("hello", [])
        assert result == "hello"

    def test_text_file_prepended(self):
        f = AttachedFile(name="code.py", content_type="text", content="def bar(): pass", size_kb=1)
        result = build_message_content("Explique ce code", [f])
        assert isinstance(result, str)
        assert "def bar" in result
        assert "Explique ce code" in result

    def test_image_file_returns_list(self):
        f = AttachedFile(name="img.png", content_type="image",
                        content="data:image/png;base64,abc", size_kb=5)
        result = build_message_content("Que vois-tu ?", [f])
        assert isinstance(result, list)
        assert any(p.get("type") == "image_url" for p in result)
        assert any(p.get("type") == "text" for p in result)
