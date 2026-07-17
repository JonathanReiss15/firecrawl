import pytest

from firecrawl.v2.methods.browser import browser
from firecrawl.v2.methods.aio.browser import browser as async_browser


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.ok = status_code < 400

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


class _FakeClient:
    def __init__(self, response: _FakeResponse):
        self.response = response
        self.last_post = None

    def post(self, endpoint, payload):
        self.last_post = (endpoint, payload)
        return self.response


class _FakeAsyncClient:
    def __init__(self, response: _FakeResponse):
        self.response = response
        self.last_post = None

    async def post(self, endpoint, payload):
        self.last_post = (endpoint, payload)
        return self.response


_OK = {"success": True, "id": "sess-1"}


class TestBrowserCreateSerialization:
    def test_url_serialized_when_set(self):
        client = _FakeClient(_FakeResponse(200, _OK))
        browser(client, url="https://example.com", ttl=60)
        endpoint, payload = client.last_post
        assert endpoint == "/v2/browser"
        assert payload["url"] == "https://example.com"
        assert payload["ttl"] == 60

    def test_url_omitted_when_not_set(self):
        client = _FakeClient(_FakeResponse(200, _OK))
        browser(client, ttl=60)
        _, payload = client.last_post
        assert "url" not in payload

    @pytest.mark.asyncio
    async def test_url_serialized_when_set_async(self):
        client = _FakeAsyncClient(_FakeResponse(200, _OK))
        await async_browser(client, url="https://example.com", ttl=60)
        endpoint, payload = client.last_post
        assert endpoint == "/v2/browser"
        assert payload["url"] == "https://example.com"

    @pytest.mark.asyncio
    async def test_url_omitted_when_not_set_async(self):
        client = _FakeAsyncClient(_FakeResponse(200, _OK))
        await async_browser(client, ttl=60)
        _, payload = client.last_post
        assert "url" not in payload
