"""Run production tests whose historical filenames contain hyphens and dots."""
from pathlib import Path
import importlib.util
import sys
import unittest

root = Path(__file__).resolve().parents[1]
suite = unittest.TestSuite()
for index, path in enumerate(sorted((root / 'test').glob('*.test.py'))):
    spec = importlib.util.spec_from_file_location(f'production_tests_{index}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
if not suite.countTestCases():
    raise RuntimeError('No production tests found')
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
