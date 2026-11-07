"""One versioned release contract. No runtime prompt or oracle generation."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "manifest.json").read_text())
FILL = MANIFEST["fill_turns"]
NOTICE = {int(k): v for k, v in MANIFEST["notices"].items()}
HIDDEN = {int(k): v for k, v in MANIFEST["hidden"].items()}
GROUPS = MANIFEST["groups"]
ROUNDS = MANIFEST["rounds"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    # Duplicate keys and NaN are corruption, not last-writer-wins input.
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError("duplicate JSON key")
            obj[key] = value
        return obj
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def validate_contract():
    # No env/CLI override may turn a subset into a release cell.
    if (GROUPS, ROUNDS, len(FILL), MANIFEST["fill_per_cell"]) != (10, 31, 23, 230):
        raise ValueError("release dimensions changed; requires a new reviewed contract")
    raw = (HERE / "prompts.json").read_bytes()
    if sha(raw) != MANIFEST["prompts_sha256"]:
        raise ValueError("frozen prompts hash mismatch")
    prompts = read_json(HERE / "prompts.json")
    if [x["turn"] for x in prompts] != list(range(1, ROUNDS + 1)):
        raise ValueError("prompt map mismatch")
    return prompts


def fingerprints():
    validate_contract()
    names = ["manifest.json", "prompts.json", "contract.py", "mkfx.py", "rubric.py", "command_audit.py",
             "score.py", "run.py", "semantic.py", "SEMANTIC.md", "run_all.sh", "run_one.sh"]
    return {name: sha((HERE / name).read_bytes()) for name in names}
