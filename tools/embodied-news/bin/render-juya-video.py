"""Load the fixed upstream snapshot and install local production adapters."""
from pathlib import Path
import importlib.util
import os
import shutil
import sys
from functools import lru_cache

source = Path(__file__).resolve().parents[1] / "vendor/juya-news-card/tools/evening-video/render_evening.py"
spec = importlib.util.spec_from_file_location("juya_evening", source)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
if os.name == "nt":
    renderer.FONT_CANDIDATES[:0] = [
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc"),
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf"),
    ]
    if not shutil.which("ffmpeg"):
        packages = Path(os.environ["LOCALAPPDATA"]) / "Microsoft/WinGet/Packages"
        binaries = sorted(packages.glob("Gyan.FFmpeg_*/ffmpeg-*/bin"))
        if not binaries:
            raise RuntimeError("FFmpeg / FFprobe are missing")
        os.environ["PATH"] = str(binaries[-1]) + os.pathsep + os.environ["PATH"]
renderer._font = lru_cache(maxsize=128)(renderer._font)
renderer.fit_lines = lru_cache(maxsize=1024)(renderer.fit_lines)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from juya_production import install
install(renderer)

# Keep the upstream Juya renderer; add provenance at its public render boundary.
from juya_review import build_identity, write as write_receipt
_original_render = renderer.render
def versioned_render(manifest_path, outdir, args):
    import json
    manifest_path=manifest_path.resolve()
    parameters={k:getattr(args,k,None) for k in ('width','height','fps','seed','publication_ready')}
    parameters['font']=str(renderer._font(40).path)
    before=build_identity(manifest_path,parameters)
    metadata=_original_render(manifest_path,outdir,args)
    final=Path(metadata['output'])
    try:
        after=build_identity(manifest_path,parameters)
        if before['buildHash']!=after['buildHash']:
            raise renderer.RenderError('Production inputs changed during render; output requires a fresh render')
        metadata['productionBinding']={'manifest':os.path.relpath(manifest_path,final.parent).replace('\\','/'),'inputs':before}
        write_receipt(final.with_suffix('.manifest.json'),metadata)
    except Exception:
        write_receipt(final.with_suffix('.status.json'),{'status':'failed','reason':'Version binding failed'})
        raise
    return metadata
renderer.render=versioned_render
if __name__ == "__main__":
    raise SystemExit(renderer.main())
