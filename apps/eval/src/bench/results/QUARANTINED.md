# Quarantined Historical Snapshots

The JSON files in this directory's parent were created before the comparable
snapshot schema. They remain available as raw historical artifacts but are
programmatically rejected by `competitors.ts --combine` and must not be used as
quality, recall, precision, or head-to-head claims.

| Artifact                                                                             | Why it is quarantined                                                                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `inspiringprotrader2121-coder_Velatrix-Cloud_139-147__2026-07-17T19-54-39-689Z.json` | Legacy pairwise-array schema; lacks anchored/all measurement partition, strict parser provenance, and model/configuration identity. |
| `inspiringprotrader2121-coder_Velatrix-Cloud_220-229__2026-08-04T22-48-00-013Z.json` | Legacy pairwise-array schema; lacks anchored/all measurement partition, strict parser provenance, and model/configuration identity. |
| `inspiringprotrader2121-coder_Velatrix-Cloud_220-229__2026-08-04T23-00-22-320Z.json` | Legacy pairwise-array schema; lacks anchored/all measurement partition, strict parser provenance, and model/configuration identity. |

No historical label or metric is reconstructed from these files. A new,
explicitly controlled run is required for a comparable result.
