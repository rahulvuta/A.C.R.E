"""Economics (card S3): per-crop prices, yields and costs for a location, from the farmer's own
numbers or sourced references only. See :func:`estimate_economics`."""

from acre.economics.estimate import EconomicsInputError, estimate_economics

__all__ = ["EconomicsInputError", "estimate_economics"]
