# Prioritized Desktop Backlog

Ordered by expected leverage relative to implementation effort.

- [ ] 1. Make the desktop project local-first
  Stop treating Parascene as the project’s working asset store.
  Project owns: local asset pool, metadata, timelines, generation history, prompts/settings, characters/environments, temporary and accepted outputs.
  Parascene becomes an import source and publishing destination.
  Done when: creating, generating, editing, rendering, saving, and reopening a project requires no Parascene synchronization.

- [ ] 2. Replace image/video groups with one project asset model
  Remove the split between image groups and video groups.
  Every asset has: type, origin, purpose, relationships, creation settings, lifecycle state.
  Lifecycle states: temporary, candidate, selected, used, published, discarded.
  Done when: extracted frames, generated stills, clips, audio, and final renders coexist without polluting the timeline or Parascene.

- [ ] 3. Connect desktop generation directly to Replicate
  Finish the direct Replicate integration already partially present.
  Desktop should: upload/expose local inputs, invoke models, track status, download outputs, associate with project objects, delete remote temps when appropriate.
  Put behind a provider interface so local models and other APIs can share the same commands later.
  Done when: no intermediate image or frame must be uploaded to Parascene merely to generate something.

- [ ] 4. Introduce a persistent ShotSpec
  Make the shot—not the resulting file—the central production object.
  Shot contains: characters, environment, props, camera/composition, action, first/last frames, source references, generation config, candidates, selected result, timeline placement.
  Done when: a shot can be revised or regenerated without reconstructing intent from scattered files.

- [ ] 5. Move generation outside the timeline
  Timeline assembles selected clips; it is not scaffolding for creating them.
  Capabilities: extract frame, generate start/end frames, select frame candidates, generate video candidates, promote result to timeline.
  Done when: first and last frames can be created and used without temporarily inserting and removing them from the timeline.

- [ ] 6. Expose the new capabilities to the LLM/chat
  Use chat as the experimental interface instead of designing a complete shot-building UI.
  Initial tools: createShot, updateShot, findCharacters, findEnvironments, attachReference, generateFrame, extractFrame, setFirstFrame, setLastFrame, generateVideo, selectCandidate, addShotToTimeline.
  LLM interprets intent; the app performs structured, deterministic commands.
  Done when: you can describe a shot conversationally and receive a persistent, editable ShotSpec.

- [ ] 7. Add visible action results, undo, and history
  Chat operations must not silently mutate opaque state.
  Every action shows: what changed, entities/references used, inferred settings, generated outputs, undo/revert, resulting structured object.
  Record the natural-language request, tool calls, corrections, and accepted result.
  Done when: chat is fast without becoming untrustworthy or irreproducible.

- [ ] 8. Make characters first-class local entities
  Bring the Parascene character concept fully into the desktop client.
  Character supports: identity/appearance, reference images, outfits, expressions, poses, voices/audio, prompt fragments, model-specific instructions, accepted/rejected depictions, relationships to scenes/environments.
  Chat can create and edit these initially without a sophisticated UI.
  Done when: “use Mara in the red dress” resolves to durable project data rather than prompt text.

- [ ] 9. Make environments first-class entities
  Environment includes: reference images, visual description, layout/spatial notes, lighting variants, time-of-day variants, recurring camera positions, associated props, model-specific prompt material.
  Done when: the same location can be reused across shots with meaningful continuity.

- [ ] 10. Build automatic reference-package assembly
  Given a shot, assemble references needed by Seedance or another model.
  Packages may include: character sheet, outfit reference, environment reference, prop references, previous-shot continuity frame, composition sketch, first/last frames.
  Model adapter determines required format.
  Done when: “prepare this shot for Seedance” produces an appropriate reference sheet or bundle automatically.

- [ ] 11. Add fixed-camera wide-plate shots with a virtual output camera
  Capability from the woman-and-owl idea.
  Shot supports: source canvas wider than final output, fixed AI-generated camera, subjects in separate regions, final 9:16 crop window, crop-position keyframes, holds/pans/cuts/easing, optional digital push-in, safe zones and overscan.
  LLM can initially infer all settings.
  Done when: Parascene controls framing while the generation model only handles subject performance.

- [ ] 12. Add candidate-generation and promotion workflow
  Every generation is a candidate until accepted.
  Support: multiple still/clip candidates, comparison, selection, rejection, regeneration with one changed property, promotion to shot, promotion to timeline.
  Done when: experimentation no longer produces an undifferentiated pile of assets.

- [ ] 13. Add scene and continuity concepts
  Once shots work, group them into scenes.
  Scene establishes: participating characters, environment, wardrobe, lighting, screen direction, time, style, continuity rules.
  Enables commands like reverse-angle shots that preserve lighting, wardrobe, and screen direction.
  Done when: the LLM can derive a new shot from surrounding shots rather than starting from nothing.

- [ ] 14. Preserve the existing direct-manipulation surfaces
  Do not replace the working interface. Keep conventional UI where it is already superior: timeline, preview, asset library, candidate grid, crop/frame control, inspector.
  Chat orchestrates these surfaces instead of replacing them.

- [ ] 15. Instrument chat usage to discover future UI
  Track: commonly invoked commands, repeated corrections, repeatedly altered settings, frequent failures, undos, workflows that require many chat turns.
  Promote into dedicated UI when frequent, precision-sensitive, error-prone, or visually easier to manipulate.
  Done when: interface design is based on observed use rather than anticipated use.

- [ ] 16. Add local model adapters
  Same generation interface for: Replicate, local ComfyUI, local image/video generation, future remote providers.
  Avoid leaking provider-specific settings into the core shot model.
  Done when: a shot can change generation provider without being rebuilt.

- [ ] 17. Add project packaging and machine transfer
  Projects are currently effectively tied to one machine.
  Add: portable project bundle, relative asset paths, missing-asset detection, export/import, optional external media references, later selective sync.
  Do this before attempting full cloud project synchronization.
  Done when: a project can move between machines without Parascene as an accidental sync system.

- [ ] 18. Publish selected results back to Parascene
  Publishing should be deliberate and sparse.
  Potential published objects: final video, selected key frame, character page, challenge submission, project teaser, externally hosted YouTube video, Suno song/album.
  Never publish intermediate frames merely because they were generated.

- [ ] 19. Add external-platform publishing
  Later adapter problem, not core production architecture.
  Order: render final local file → publish Parascene representation → YouTube → Instagram (where permitted) → TikTok (where permitted).
  Fallback: prepared export package with file, caption, title, thumbnail, and metadata.

- [ ] 20. Improve long-form local export
  Continue hardening: reliable FFmpeg rendering, long timelines, audio sync, transition rendering, framing/crop animation, resumable/recoverable exports, output presets for 9:16, 16:9, and platform targets.
  More important once shot generation is no longer the bottleneck.

## Recommended immediate sequence

1. Local project and unified asset pool
2. Direct Replicate adapter
3. Persistent ShotSpec
4. Generation outside the timeline
5. Chat-accessible shot commands
6. Characters and environments
7. Reference-package assembly
8. Fixed-camera plate and virtual crop
9. Candidate promotion into timeline
10. Selective publishing

That sequence first removes the existing pain, then creates the semantic foundation, then proves the new AI-native workflow without requiring a large UI investment.
