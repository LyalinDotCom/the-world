#!/usr/bin/env python3
import json
import sys
import traceback

import litert_lm
from litert_lm_cli import model as model_manager


def backend_from_name(name):
  return litert_lm.Backend.GPU if name == "gpu" else litert_lm.Backend.CPU


def text_from_response(response):
  return "".join(
      item.get("text", "")
      for item in response.get("content", [])
      if item.get("type") == "text"
  )


def write_message(message):
  sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
  sys.stdout.flush()


def main():
  config = json.loads(sys.stdin.readline())
  model_ref = config["model"]
  model_obj = model_manager.Model.from_model_id(model_ref)
  if not model_obj.exists():
    raise FileNotFoundError(f"LiteRT-LM model not found: {model_ref}")

  backend = backend_from_name(config.get("backend", "gpu"))
  max_num_tokens = config.get("maxNumTokens")
  engine = litert_lm.Engine(
      model_obj.model_path,
      backend=backend,
      max_num_tokens=max_num_tokens,
  )
  engine.__enter__()
  write_message({
      "type": "ready",
      "model": model_ref,
      "backend": config.get("backend", "gpu"),
  })

  try:
    for line in sys.stdin:
      if not line.strip():
        continue
      request = json.loads(line)
      request_id = request["id"]
      try:
        sampler = litert_lm.SamplerConfig(
            top_p=request.get("topP"),
            temperature=request.get("temperature"),
            seed=request.get("seed"),
        )
        with engine.create_conversation(sampler_config=sampler) as conversation:
          response = conversation.send_message(request["prompt"])
        write_message({
            "type": "response",
            "id": request_id,
            "text": text_from_response(response),
        })
      except Exception as error:  # pylint: disable=broad-exception-caught
        write_message({
            "type": "error",
            "id": request_id,
            "error": "".join(traceback.format_exception_only(error)).strip(),
        })
  finally:
    engine.__exit__(None, None, None)


if __name__ == "__main__":
  try:
    main()
  except Exception as error:  # pylint: disable=broad-exception-caught
    write_message({
        "type": "fatal",
        "error": "".join(traceback.format_exception_only(error)).strip(),
    })
    raise
