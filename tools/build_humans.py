import bpy, sys, os
from mathutils import Vector

src, out = sys.argv[sys.argv.index("--") + 1:][:2]

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o not in before]

def material(name, color, roughness, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat

def region_of(bone):
    b = bone.split(":")[-1]
    if "Hand" in b or b.startswith(("Head", "Neck")):
        return "hands" if "Hand" in b else "head"
    if "Foot" in b or "Toe" in b:
        return "feet"
    if "Leg" in b or b == "Hips":
        return "legs"
    return "torso"

def paint_regions(meshes, slots):
    for m in meshes:
        m.data.materials.clear()
        for mat in dict.fromkeys(slots.values()):
            m.data.materials.append(mat)
        index = {mat.name: i for i, mat in enumerate(m.data.materials)}
        group_region = {g.index: region_of(g.name) for g in m.vertex_groups}
        vertex_region = []
        for v in m.data.vertices:
            best = max(v.groups, key=lambda g: g.weight, default=None)
            vertex_region.append(group_region.get(best.group, "torso") if best else "torso")
        for p in m.data.polygons:
            regions = [vertex_region[i] for i in p.vertices]
            p.material_index = index[slots[max(set(regions), key=regions.count)].name]

def decimate(meshes, ratio):
    for m in meshes:
        mod = m.modifiers.new("dec", "DECIMATE")
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = m
        bpy.ops.object.modifier_move_to_index(modifier="dec", index=0)
        bpy.ops.object.modifier_apply(modifier="dec")

def tris(meshes):
    return sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)

def bone_world(arm, name):
    bone = next(b for b in arm.pose.bones if b.name.endswith(name))
    return arm.matrix_world @ bone.head

reset()
objs = imported(f"{src}/Driving.fbx")
arm = next(o for o in objs if o.type == "ARMATURE")
meshes = [o for o in objs if o.type == "MESH"]
bpy.context.scene.frame_set(40)
suit = material("suit", (0.8, 0.8, 0.8), 0.55)
paint_regions(meshes, {
    "head": material("skin", (0.78, 0.57, 0.45), 0.6),
    "hands": material("gloves", (0.05, 0.05, 0.05), 0.7),
    "torso": suit,
    "legs": suit,
    "feet": material("shoes", (0.04, 0.04, 0.04), 0.5),
})
head = bone_world(arm, "Head")
top = bone_world(arm, "HeadTop_End")
for m in meshes:
    bpy.context.view_layer.objects.active = m
    for mod in list(m.modifiers):
        if mod.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=mod.name)
    world = m.matrix_world.copy()
    m.parent = None
    m.matrix_world = world
bpy.data.objects.remove(arm)
decimate(meshes, 0.25)

center = (head + top) / 2
up = (top - head).normalized()
size = (top - head).length
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=size * 0.58, location=center)
helmet = bpy.context.active_object
helmet.name = "helmet"
helmet.data.materials.append(material("helmet", (0.9, 0.9, 0.9), 0.15))
bpy.ops.object.shade_smooth()
forward = Vector((0, -1, 0))
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=size * 0.5, location=center + forward * size * 0.5)
visor = bpy.context.active_object
visor.name = "visor"
visor.scale = (0.85, 0.3, 0.42)
visor.data.materials.append(material("visor", (0.02, 0.02, 0.03), 0.05, 0.9))
bpy.ops.object.shade_smooth()
print("DRIVER tris", tris(meshes + [helmet, visor]))
bpy.ops.export_scene.gltf(filepath=f"{out}/pilote.glb", export_format="GLB", export_animations=False, export_skins=False)

reset()
clips = {"Cheering": "cheering", "Clapping": "clapping", "Standing Clap": "standingClap", "Rallying": "rallying", "Dizzy Idle": "idle"}
base = None
for file, name in clips.items():
    objs = imported(f"{src}/{file}.fbx")
    a = next(o for o in objs if o.type == "ARMATURE")
    a.animation_data.action.name = name
    a.animation_data.action.use_fake_user = True
    if base is None:
        base = a
        crowd = [o for o in objs if o.type == "MESH"]
    else:
        for o in objs:
            bpy.data.objects.remove(o)
skin = material("skin", (0.78, 0.57, 0.45), 0.6)
paint_regions(crowd, {
    "head": skin,
    "hands": skin,
    "torso": material("shirt", (0.7, 0.2, 0.2), 0.85),
    "legs": material("pants", (0.12, 0.16, 0.28), 0.9),
    "feet": material("shoes", (0.9, 0.9, 0.9), 0.6),
})
decimate(crowd, 0.08)
print("CROWD tris", tris(crowd))
base.animation_data.action = bpy.data.actions["idle"]
bpy.ops.export_scene.gltf(filepath=f"{out}/spectateur.glb", export_format="GLB", export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=2)
for f in ("pilote.glb", "spectateur.glb"):
    print("FILE", f, os.path.getsize(f"{out}/{f}") // 1024, "KB")
