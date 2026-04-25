# Contributing to openagentic-ai

## Setup

```bash
git clone https://github.com/HcodeQ/openagentic-ai
cd openagentic-ai
pip install -e ".[all]"
pip install pytest deepeval
```

## Running the tests

```bash
# All unit tests (no LLM required)
pytest tests/ -v -m "not llm_eval"

# A specific file
pytest tests/test_loop_detector.py -v
pytest tests/test_messages.py -v
pytest tests/test_persistence.py -v
pytest tests/test_nodes.py -v
pytest tests/test_utils.py -v
```

## LLM quality tests (DeepEval)

These tests use an LLM judge to evaluate prompt and response quality.
They require an OpenAI API key (used by DeepEval as the evaluator).

```bash
export OPENAI_API_KEY=sk-...
pytest tests/test_deepeval_quality.py -v
```

To run everything at once:

```bash
pytest tests/ -v
```

## Test structure

| File | What it covers |
|---|---|
| `test_loop_detector.py` | Loop detection (same call, 2-step cycle, same file edits) |
| `test_messages.py` | `trim_message_history`, `clean_messages` |
| `test_utils.py` | `mode_router`, `parse_mentions`, `_detect_provider` |
| `test_persistence.py` | Session save / load / list |
| `test_nodes.py` | `route_after_agent`, `make_agent_node` |
| `test_deepeval_quality.py` | Prompt and response quality (LLM judge) |

## Submitting changes

1. Fork the repo and create a branch
2. Make your changes
3. Run `pytest tests/ -v -m "not llm_eval"` and make sure all tests pass
4. Open a pull request
