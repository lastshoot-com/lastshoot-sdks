"""Generate the endpoint layer of the Python and TypeScript SDKs from spec/openapi.json.

Run from the repo root:

    python scripts/codegen.py            # write generated files
    python scripts/codegen.py --check    # exit 1 if generated files are stale

Only request/response schemas the spec defines are emitted. Hand-written code
(HTTP, retries, polling, errors, upload) lives next to the generated files.
"""
from __future__ import annotations

import json
import re
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = json.loads((ROOT / "spec" / "openapi.json").read_text(encoding="utf-8"))
SCHEMAS = SPEC["components"]["schemas"]

PY_OUT = ROOT / "python" / "src" / "lastshoot" / "_endpoints.py"
TS_OUT = ROOT / "typescript" / "src" / "generated.ts"

# (namespace, python method, ts method, path, request schema, TS type stem)
ENDPOINTS = [
    ("generate", "image", "image", "/generate/image/v1", "GenerateRequest", "GenerateImage"),
    ("generate", "video", "video", "/generate/video/v1", "GenerateVideoRequest", "GenerateVideo"),
    ("generate", "speech", "speech", "/generate/speech/v1", "TextToSpeechRequest", "GenerateSpeech"),
    ("generate", "generate_3d", "generate3d", "/generate/3d/v1", "Generate3DRequest", "Generate3D"),
    ("edit", "image", "image", "/edit/image/v1", "ImageEditingRequest", "EditImage"),
    ("background", "change", "change", "/background/change/image/v1", "BackgroundChangeRequest", "BackgroundChange"),
    ("background", "remove", "remove", "/background/remove/image/v1", "BackgroundRemoveRequest", "BackgroundRemove"),
    ("upscale", "image", "image", "/upscale/image/v1", "UpscaleImageRequest", "UpscaleImage"),
    ("branding", "logo", "logo", "/branding/logo/image/v1", "BrandingLogoRequest", "BrandingLogo"),
    ("branding", "template", "template", "/branding/template/image/v1", "BrandingTemplateRequest", "BrandingTemplate"),
    ("identity", "tryon", "tryon", "/creator/tryon/image/v1", "VirtualTryonRequest", "Tryon"),
    ("identity", "faceswap", "faceswap", "/identity/faceswap/image/v1", "FaceswapRequest", "Faceswap"),
    ("identity", "lock", "lock", "/identity/lock/image/v1", "IdentityLockRequest", "IdentityLock"),
    ("identity", "replace", "replace", "/identity/replace/image/v1", "IdentityReplaceRequest", "IdentityReplace"),
    ("identity", "instamodel", "instamodel", "/creator/instamodel/image/v1", "InstaModelRequest", "Instamodel"),
    ("identity", "voice_clone", "voiceClone", "/identity/voice/clone/v1", "VoiceCloneRequest", "VoiceClone"),
]
NAMESPACES = ["generate", "edit", "background", "upscale", "branding", "identity"]

# Response schemas exposed as types: spec name -> (python name, ts name)
RESPONSE_TYPES = {
    "JobQueuedResponse": ("JobQueuedData", "JobQueuedData"),
    "JobStatusResponse": ("JobStatusData", "JobStatusData"),
    "UploadResponse": ("UploadData", "UploadData"),
    "AdapterConfigSnapshot": ("AdapterConfigSnapshot", "AdapterConfigSnapshot"),
    "IdentityProfileResponse": ("Profile", "Profile"),
    "IdentityProfileListResponse": ("ProfileList", "ProfileList"),
    "WebhookEvent": ("WebhookEvent", "WebhookEvent"),
}
PROFILE_CREATE = "IdentityProfileCreate"
PROFILE_UPDATE = "IdentityProfileUpdate"

PY_RESERVED = {"wait", "poll_interval", "timeout", "on_progress", "self"}
TS_RESERVED = {"wait", "pollInterval", "timeout", "onProgress", "signal"}


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("—", "-").replace("–", "-")).strip()


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def check_coverage() -> None:
    """Fail loudly if the spec gained a job endpoint the SDK does not wrap."""
    covered = {e[3] for e in ENDPOINTS}
    job_paths = {p[: -len("/status/{job_id}")] for p in SPEC["paths"] if p.endswith("/status/{job_id}")}
    missing = job_paths - covered
    extra = covered - job_paths
    if missing or extra:
        sys.exit(f"codegen: spec/ENDPOINTS mismatch. missing={sorted(missing)} extra={sorted(extra)}")
    for _, _, _, path, schema, _ in ENDPOINTS:
        body = SPEC["paths"][path]["post"]["requestBody"]["content"]["application/json"]["schema"]
        if ref_name(body["$ref"]) != schema:
            sys.exit(f"codegen: {path} body is {body['$ref']}, expected {schema}")


# --------------------------------------------------------------------------- types


def py_type(s: dict) -> str:
    if "$ref" in s:
        target = SCHEMAS[ref_name(s["$ref"])]
        if "enum" in target:
            return "Literal[" + ", ".join(repr(v) for v in target["enum"]) + "]"
        name = ref_name(s["$ref"])
        return RESPONSE_TYPES.get(name, (name, name))[0] if name in RESPONSE_TYPES else "Dict[str, Any]"
    if "allOf" in s and len(s["allOf"]) == 1:
        return py_type(s["allOf"][0])
    if "anyOf" in s:
        parts = [p for p in s["anyOf"] if p.get("type") != "null"]
        if not parts:
            return "Any"
        types = []
        for p in parts:
            t = py_type(p)
            if t not in types:
                types.append(t)
        return types[0] if len(types) == 1 else "Union[" + ", ".join(types) + "]"
    if "enum" in s:
        return "Literal[" + ", ".join(repr(v) for v in s["enum"]) + "]"
    t = s.get("type")
    if t == "string":
        return "str"
    if t == "integer":
        return "int"
    if t == "number":
        return "float"
    if t == "boolean":
        return "bool"
    if t == "array":
        return "List[" + py_type(s.get("items", {})) + "]"
    if t == "object":
        return "Dict[str, Any]"
    return "Any"


def ts_type(s: dict) -> str:
    if "$ref" in s:
        target = SCHEMAS[ref_name(s["$ref"])]
        if "enum" in target:
            return " | ".join(json.dumps(v) for v in target["enum"])
        name = ref_name(s["$ref"])
        return RESPONSE_TYPES[name][1] if name in RESPONSE_TYPES else "Record<string, unknown>"
    if "allOf" in s and len(s["allOf"]) == 1:
        return ts_type(s["allOf"][0])
    if "anyOf" in s:
        parts = [p for p in s["anyOf"] if p.get("type") != "null"]
        if not parts:
            return "unknown"
        types = []
        for p in parts:
            t = ts_type(p)
            if t not in types:
                types.append(t)
        return " | ".join(types)
    if "enum" in s:
        return " | ".join(json.dumps(v) for v in s["enum"])
    t = s.get("type")
    if t == "string":
        return "string"
    if t in ("integer", "number"):
        return "number"
    if t == "boolean":
        return "boolean"
    if t == "array":
        inner = ts_type(s.get("items", {}))
        return f"Array<{inner}>"
    if t == "object":
        return "Record<string, unknown>"
    return "unknown"


def nullable(s: dict) -> bool:
    return any(p.get("type") == "null" for p in s.get("anyOf", []))


def fields(schema_name: str):
    schema = SCHEMAS[schema_name]
    required = set(schema.get("required", []))
    for name, prop in schema.get("properties", {}).items():
        yield name, prop, name in required


# --------------------------------------------------------------------------- python


def py_doc_lines(summary: str, schema_name: str, indent: str) -> list[str]:
    lines = [summary, "", "Args:"]
    for name, prop, req in fields(schema_name):
        desc = clean(prop.get("description")) or "-"
        if req:
            desc = "Required. " + desc
        if "default" in prop:
            desc += f" Default: {prop['default']!r}."
        wrapped = textwrap.wrap(f"{name}: {desc}", width=84 - len(indent), subsequent_indent="    ")
        lines += ["    " + w for w in wrapped]
    lines += [
        "    wait: Block until the job finishes (default True). False returns a Job.",
        "    poll_interval: Seconds between status polls while waiting.",
        "    timeout: Max seconds to wait before raising JobTimeoutError.",
        "    on_progress: Called with each JobStatus while waiting.",
    ]
    out = [indent + '"""' + lines[0]]
    out += [(indent + l) if l else "" for l in lines[1:]]
    out.append(indent + '"""')
    return [l.replace("\\", "\\\\") for l in out]


def py_params(schema_name: str) -> list[str]:
    req, opt = [], []
    for name, prop, required in fields(schema_name):
        assert name not in PY_RESERVED, name
        t = py_type(prop)
        if required:
            req.append(f"{name}: {t}")
        else:
            opt.append(f"{name}: Optional[{t}] = None")
    return req + opt


def gen_python() -> str:
    out = [
        "# Generated by scripts/codegen.py from spec/openapi.json. Do not edit by hand.",
        "# fmt: off",
        "from __future__ import annotations",
        "",
        "from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, TypedDict, Union, overload",
        "from urllib.parse import quote",
        "",
        "if TYPE_CHECKING:",
        "    from ._client import AsyncLastShoot, LastShoot",
        "    from ._models import AsyncJob, Job, ProgressCallback, Result",
        "",
        "__all__ = [",
    ]
    names = [v[0] for v in RESPONSE_TYPES.values()]
    out += [f"    {n!r}," for n in names] + ["]", "", "", "def _seg(value: str) -> str:", '    return quote(str(value), safe="")', "", ""]

    # Response TypedDicts (snake_case, as on the wire).
    order = ["AdapterConfigSnapshot", "JobQueuedResponse", "JobStatusResponse", "UploadResponse",
             "IdentityProfileResponse", "IdentityProfileListResponse", "WebhookEvent"]
    for spec_name in order:
        py_name = RESPONSE_TYPES[spec_name][0]
        out.append(f"class {py_name}(TypedDict, total=False):")
        desc = clean(SCHEMAS[spec_name].get("description")) or f"`{spec_name}` from the LastShoot API."
        out.append(f'    """{desc}"""')
        out.append("")
        for name, prop, _ in fields(spec_name):
            t = py_type(prop)
            if spec_name == "IdentityProfileListResponse" and name == "profiles":
                t = "List[Profile]"
            if nullable(prop):
                t = f"Optional[{t}]"
            out.append(f"    {name}: {t}")
        out += ["", ""]

    for is_async in (False, True):
        for ns in NAMESPACES:
            cls = ("Async" if is_async else "") + ns.capitalize() + "Resource"
            client_t = "AsyncLastShoot" if is_async else "LastShoot"
            job_t = "AsyncJob" if is_async else "Job"
            out.append(f"class {cls}:")
            out.append(f'    """`client.{ns}` methods."""')
            out.append("")
            out.append(f"    def __init__(self, client: {client_t}) -> None:")
            out.append("        self._client = client")
            for _, meth, _, path, schema, _ in [e for e in ENDPOINTS if e[0] == ns]:
                op = SPEC["paths"][path]["post"]
                summary = clean(op.get("summary")) or meth
                summary = f"{summary}. `POST {path}`"
                params = py_params(schema)
                run_opts = [
                    "poll_interval: Optional[float] = None",
                    "timeout: Optional[float] = None",
                    "on_progress: Optional[ProgressCallback] = None",
                ]
                d = "async def" if is_async else "def"
                for wait_sig, ret in (("wait: Literal[True] = True", "Result"), ("wait: Literal[False]", job_t)):
                    out.append("")
                    out.append("    @overload")
                    sig = ", ".join(["self", "*"] + params + [wait_sig] + run_opts)
                    out.append(f"    {d} {meth}({sig}) -> {ret}: ...")
                out.append("")
                sig = ", ".join(["self", "*"] + params + ["wait: bool = True"] + run_opts)
                out.append(f"    {d} {meth}({sig}) -> Union[Result, {job_t}]:")
                out += py_doc_lines(summary, schema, "        ")
                body = ", ".join(f'"{n}": {n}' for n, _, _ in fields(schema))
                aw = "await " if is_async else ""
                out.append(f"        body: Dict[str, Any] = {{{body}}}")
                out.append(
                    f"        return {aw}self._client._run({path!r}, body, wait=wait, poll_interval=poll_interval,"
                    " timeout=timeout, on_progress=on_progress)"
                )
            if ns == "identity":
                out += gen_python_profiles(is_async)
            out += ["", ""]
    return "\n".join(out).rstrip() + "\n"


def gen_python_profiles(is_async: bool) -> list[str]:
    d = "async def" if is_async else "def"
    aw = "await " if is_async else ""
    out = []
    # create
    params = py_params(PROFILE_CREATE)
    out += ["", f"    {d} create_profile(self, *, {', '.join(params)}) -> Profile:"]
    out.append('        """Create an identity profile. `POST /profiles/v1`"""')
    body = ", ".join(f'"{n}": {n}' for n, _, _ in fields(PROFILE_CREATE))
    out.append(f"        body: Dict[str, Any] = {{{body}}}")
    out.append(f'        return {aw}self._client._request_json("POST", "/profiles/v1", json=body)  # type: ignore[no-any-return]')
    # list
    out += ["", f"    {d} list_profiles(self) -> ProfileList:"]
    out.append('        """List identity profiles. `GET /profiles/v1`"""')
    out.append(f'        return {aw}self._client._request_json("GET", "/profiles/v1")  # type: ignore[no-any-return]')
    # get
    out += ["", f"    {d} get_profile(self, profile_id: str) -> Profile:"]
    out.append('        """Get one identity profile. `GET /profiles/v1/{profile_id}`"""')
    out.append(f'        return {aw}self._client._request_json("GET", f"/profiles/v1/{{_seg(profile_id)}}")  # type: ignore[no-any-return]')
    # update
    params = py_params(PROFILE_UPDATE)
    out += ["", f"    {d} update_profile(self, profile_id: str, *, {', '.join(params)}) -> Profile:"]
    out.append('        """Update an identity profile (only fields you pass are sent). `PATCH /profiles/v1/{profile_id}`"""')
    body = ", ".join(f'"{n}": {n}' for n, _, _ in fields(PROFILE_UPDATE))
    out.append(f"        body: Dict[str, Any] = {{{body}}}")
    out.append(f'        return {aw}self._client._request_json("PATCH", f"/profiles/v1/{{_seg(profile_id)}}", json=body)  # type: ignore[no-any-return]')
    # delete
    out += ["", f"    {d} delete_profile(self, profile_id: str) -> None:"]
    out.append('        """Delete an identity profile. `DELETE /profiles/v1/{profile_id}`"""')
    out.append(f'        {aw}self._client._request_json("DELETE", f"/profiles/v1/{{_seg(profile_id)}}")')
    return out


# --------------------------------------------------------------------------- typescript


def jsdoc(text: str, indent: str) -> list[str]:
    text = text.replace("*/", "*\\/")
    wrapped = textwrap.wrap(text, width=96 - len(indent))
    if len(wrapped) <= 1:
        return [f"{indent}/** {text} */"]
    return [f"{indent}/**"] + [f"{indent} * {w}" for w in wrapped] + [f"{indent} */"]


def ts_interface(name: str, schema_name: str, camel_case: bool, overrides: dict | None = None, request: bool = False) -> list[str]:
    out = jsdoc(clean(SCHEMAS[schema_name].get("description")) or f"`{schema_name}` from the LastShoot API.", "")
    out.append(f"export interface {name} {{")
    for field, prop, req in fields(schema_name):
        key = camel(field) if camel_case else field
        t = (overrides or {}).get(field) or ts_type(prop)
        if nullable(prop) and not request:
            t += " | null"
        desc = clean(prop.get("description"))
        if "default" in prop and camel_case:
            desc = (desc + f" Default: `{json.dumps(prop['default'])}`.").strip()
        if desc:
            out += jsdoc(desc, "  ")
        out.append(f"  {key}{'' if req else '?'}: {t};")
    out.append("}")
    return out


def gen_typescript() -> str:
    out = [
        "// Generated by scripts/codegen.py from spec/openapi.json. Do not edit by hand.",
        "/* eslint-disable */",
        'import type { Job, JobResult, RunOptions, Runner, WaitOptions } from "./core.js";',
        "",
    ]
    # Response types: wire shape (snake_case) for webhook; camelCase for SDK-returned objects.
    out += ts_interface("AdapterConfigSnapshot", "AdapterConfigSnapshot", True)
    out.append("")
    out += ts_interface("Profile", "IdentityProfileResponse", True)
    out.append("")
    out += ts_interface("ProfileList", "IdentityProfileListResponse", True, {"profiles": "Profile[]"})
    out.append("")
    out += ts_interface("JobStatusData", "JobStatusResponse", True)
    out.append("")
    out += ts_interface("JobQueuedData", "JobQueuedResponse", True)
    out.append("")
    out += ts_interface("UploadData", "UploadResponse", True)
    out.append("")
    out += ts_interface("WebhookEvent", "WebhookEvent", False)
    out.append("")

    # Request param interfaces + key maps
    for _, _, _, path, schema, stem in ENDPOINTS:
        out += ts_interface(f"{stem}Params", schema, True, request=True)
        keys = ", ".join(f"{camel(n)}: {json.dumps(n)}" for n, _, _ in fields(schema))
        for n, _, _ in fields(schema):
            assert camel(n) not in TS_RESERVED, n
        out.append(f"const {stem}Keys: Record<string, string> = {{ {keys} }};")
        out.append("")
    for schema, stem in ((PROFILE_CREATE, "CreateProfile"), (PROFILE_UPDATE, "UpdateProfile")):
        out += ts_interface(f"{stem}Params", schema, True, request=True)
        keys = ", ".join(f"{camel(n)}: {json.dumps(n)}" for n, _, _ in fields(schema))
        out.append(f"const {stem}Keys: Record<string, string> = {{ {keys} }};")
        out.append("")

    for ns in NAMESPACES:
        cls = ns.capitalize() + "Resource"
        out += jsdoc(f"`client.{ns}` methods.", "")
        out.append(f"export class {cls} {{")
        out.append("  constructor(private readonly client: Runner) {}")
        for _, _, meth, path, schema, stem in [e for e in ENDPOINTS if e[0] == ns]:
            op = SPEC["paths"][path]["post"]
            summary = (clean(op.get("summary")) or meth) + f". `POST {path}`"
            p = f"{stem}Params"
            out.append("")
            out += jsdoc(summary + " Blocks until done unless `wait: false`.", "  ")
            out.append(f"  {meth}(params: {p} & WaitOptions & {{ wait?: true }}): Promise<JobResult>;")
            out.append(f"  {meth}(params: {p} & {{ wait: false }}): Promise<Job>;")
            out.append(f"  {meth}(params: {p} & RunOptions): Promise<JobResult | Job>;")
            out.append(f"  {meth}(params: {p} & RunOptions): Promise<JobResult | Job> {{")
            out.append(f"    return this.client.run({json.dumps(path)}, params, {stem}Keys);")
            out.append("  }")
        if ns == "identity":
            out += [
                "",
                "  /** Create an identity profile. `POST /profiles/v1` */",
                "  createProfile(params: CreateProfileParams): Promise<Profile> {",
                '    return this.client.json("POST", "/profiles/v1", params, CreateProfileKeys) as Promise<Profile>;',
                "  }",
                "",
                "  /** List identity profiles. `GET /profiles/v1` */",
                "  listProfiles(): Promise<ProfileList> {",
                '    return this.client.json("GET", "/profiles/v1") as Promise<ProfileList>;',
                "  }",
                "",
                "  /** Get one identity profile. `GET /profiles/v1/{profile_id}` */",
                "  getProfile(profileId: string): Promise<Profile> {",
                '    return this.client.json("GET", `/profiles/v1/${encodeURIComponent(profileId)}`) as Promise<Profile>;',
                "  }",
                "",
                "  /** Update an identity profile. `PATCH /profiles/v1/{profile_id}` */",
                "  updateProfile(profileId: string, params: UpdateProfileParams): Promise<Profile> {",
                '    return this.client.json("PATCH", `/profiles/v1/${encodeURIComponent(profileId)}`, params, UpdateProfileKeys) as Promise<Profile>;',
                "  }",
                "",
                "  /** Delete an identity profile. `DELETE /profiles/v1/{profile_id}` */",
                "  async deleteProfile(profileId: string): Promise<void> {",
                '    await this.client.json("DELETE", `/profiles/v1/${encodeURIComponent(profileId)}`);',
                "  }",
            ]
        out.append("}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main() -> None:
    check_coverage()
    outputs = {PY_OUT: gen_python(), TS_OUT: gen_typescript()}
    if "--check" in sys.argv:
        stale = [str(p) for p, text in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            sys.exit("codegen: stale generated files: " + ", ".join(stale))
        print("codegen: up to date")
        return
    for p, text in outputs.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
