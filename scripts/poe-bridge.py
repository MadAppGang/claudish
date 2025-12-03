#!/usr/bin/env python3
"""
Poe API Bridge for Claudish.

Receives Claude-format request on stdin, calls Poe API via fastapi-poe,
outputs Anthropic-compatible SSE events to stdout.

Supports thinking_budget parameter for extended reasoning on compatible models
(e.g., Claude-Sonnet-4, Grok-4-reasoning).

Usage:
    echo '{"model":"Claude-Sonnet-4.5","messages":[...],"thinking_budget":16000}' | python poe-bridge.py

Environment:
    POE_API_KEY - API key from https://poe.com/api_key
"""

import asyncio
import json
import os
import random
import string
import sys
import time
from typing import Any

try:
    import fastapi_poe as fp
except ImportError:
    print(json.dumps({
        "error": "fastapi-poe not installed. Run: pip install fastapi-poe"
    }), file=sys.stderr)
    sys.exit(1)


def generate_id(prefix: str = "msg") -> str:
    """Generate unique ID like msg_01XFDUDYJgAACzvnptvVAAUg."""
    chars = string.ascii_letters + string.digits
    suffix = "".join(random.choices(chars, k=24))
    return f"{prefix}_{suffix}"


def send_sse(event: str, data: dict[str, Any]) -> None:
    """Send SSE event to stdout in Anthropic format."""
    print(f"event: {event}", flush=True)
    print(f"data: {json.dumps(data)}", flush=True)
    print(flush=True)


def convert_content_to_text(content: Any) -> str:
    """Convert Claude content format to plain text."""
    if isinstance(content, str):
        return content
    
    if isinstance(content, list):
        text_parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif block.get("type") == "tool_result":
                    # Handle tool results
                    result = block.get("content", "")
                    if isinstance(result, str):
                        text_parts.append(result)
                    elif isinstance(result, list):
                        for r in result:
                            if isinstance(r, dict) and r.get("type") == "text":
                                text_parts.append(r.get("text", ""))
        return "\n".join(text_parts)
    
    return str(content)


async def stream_response(
    bot_name: str,
    messages: list[dict[str, Any]],
    system: str,
    api_key: str,
    thinking_budget: int | None = None
) -> None:
    """Stream Poe response as Anthropic-compatible SSE events.
    
    Supports thinking/reasoning parameters for compatible models:
    - thinking_budget: For Claude models (numeric token budget)
    - Automatically converts to reasoning_effort for GPT models (string)
    """
    
    # Convert messages to Poe format
    poe_messages: list[fp.ProtocolMessage] = []
    
    # Add system message if present
    if system:
        poe_messages.append(fp.ProtocolMessage(role="system", content=system))
    
    # Determine if we need to pass parameters (thinking/reasoning)
    # Claude models use thinking_budget (numeric)
    # GPT models use reasoning_effort (string: low/medium/high)
    message_parameters = {}
    if thinking_budget is not None:
        # Check if this is a GPT model (needs reasoning_effort string)
        if "gpt" in bot_name.lower() or "o1" in bot_name.lower() or "o3" in bot_name.lower():
            # Convert numeric budget to reasoning_effort level
            if thinking_budget < 4000:
                message_parameters["reasoning_effort"] = "low"
            elif thinking_budget < 16000:
                message_parameters["reasoning_effort"] = "low"
            elif thinking_budget < 32000:
                message_parameters["reasoning_effort"] = "medium"
            else:
                message_parameters["reasoning_effort"] = "high"
        else:
            # Claude, Grok, and other models use thinking_budget directly
            message_parameters["thinking_budget"] = thinking_budget
    
    for msg in messages:
        role = msg.get("role", "user")
        content = convert_content_to_text(msg.get("content", ""))
        
        if content:  # Only add non-empty messages
            # Pass parameters only with the last user message (Poe convention)
            if role == "user" and message_parameters and msg == messages[-1]:
                poe_messages.append(
                    fp.ProtocolMessage(role=role, content=content, parameters=message_parameters)
                )
            else:
                poe_messages.append(fp.ProtocolMessage(role=role, content=content))
    
    # Generate message ID
    msg_id = generate_id("msg")
    
    # Send message_start
    send_sse("message_start", {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": bot_name,
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 100, "output_tokens": 1}
        }
    })
    
    # Send content_block_start
    send_sse("content_block_start", {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""}
    })
    
    # Send initial ping
    send_sse("ping", {"type": "ping"})
    
    # Stream response from Poe
    output_tokens = 0
    last_ping = time.time()
    
    # Prepare kwargs for get_bot_response
    request_kwargs: dict[str, Any] = {
        "messages": poe_messages,
        "bot_name": bot_name,
        "api_key": api_key,
    }
    
    # Note: thinking_budget/reasoning_effort are passed via ProtocolMessage.parameters
    # NOT as top-level kwargs to get_bot_response
    
    try:
        async for partial in fp.get_bot_response(**request_kwargs):
            if partial.text:
                # Rough token estimate (1 token ≈ 4 chars)
                output_tokens += max(1, len(partial.text) // 4)
                
                send_sse("content_block_delta", {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": partial.text}
                })
            
            # Send periodic pings to keep connection alive
            if time.time() - last_ping > 1:
                send_sse("ping", {"type": "ping"})
                last_ping = time.time()
    
    except Exception as e:
        # Send error event in Anthropic format
        send_sse("error", {
            "type": "error",
            "error": {"type": "api_error", "message": str(e)}
        })
        print("data: [DONE]", flush=True)
        return
    
    # Send content_block_stop
    send_sse("content_block_stop", {
        "type": "content_block_stop",
        "index": 0
    })
    
    # Send message_delta with final usage
    send_sse("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": output_tokens}
    })
    
    # Send message_stop
    send_sse("message_stop", {"type": "message_stop"})
    
    # Send done marker
    print("data: [DONE]", flush=True)


def extract_system(request: dict[str, Any]) -> str:
    """Extract system message from request."""
    system = request.get("system", "")
    
    if isinstance(system, str):
        return system
    
    if isinstance(system, list):
        parts = []
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    
    return ""


def main() -> None:
    """Main entry point."""
    api_key = os.environ.get("POE_API_KEY")
    
    if not api_key:
        send_sse("error", {
            "type": "error",
            "error": {
                "type": "authentication_error",
                "message": "POE_API_KEY environment variable not set. Get your key from https://poe.com/api_key"
            }
        })
        print("data: [DONE]", flush=True)
        sys.exit(1)
    
    # Read request from stdin
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("Empty input")
        request = json.loads(raw_input)
    except (json.JSONDecodeError, ValueError) as e:
        send_sse("error", {
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": f"Invalid JSON input: {e}"
            }
        })
        print("data: [DONE]", flush=True)
        sys.exit(1)
    
    bot_name = request.get("model", "GPT-3.5-Turbo")
    messages = request.get("messages", [])
    system = extract_system(request)
    thinking_budget = request.get("thinking_budget")
    
    # Run async stream
    asyncio.run(stream_response(bot_name, messages, system, api_key, thinking_budget))


if __name__ == "__main__":
    main()
