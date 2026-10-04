"""FlowMap's low-latency Binance subscription policy."""

from crocodile.crypto.exchanges.binance.connector import BinanceConnector


class RealtimeBinanceConnector(BinanceConnector):
    """Request 100 ms depth updates while retaining upstream book sequencing."""

    def subscribe_channels(self) -> list[str]:
        return [
            topic + "@100ms" if topic.endswith("@depth") else topic
            for topic in super().subscribe_channels()
        ]
