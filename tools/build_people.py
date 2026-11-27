import bpy, sys, os, math
from mathutils import Vector

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
clips = {"Cheering": "cheering", "Clapping": "clapping", "Standing Clap": "standingClap", "Rallying": "rallying", "Dizzy Idle": "idle"}
spectators = [(11, "male"), (23, "female"), (37, "male"), (41, "female"), (53, "male"), (67, "female")]
texture_size = 512

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.preferences.addon_enable(module="bl_ext.blender_org.mpfb")

def create_human(seed, gender):
    sc = bpy.context.scene
    sc.MPFB_RAND_seed = seed
    sc.MPFB_RAND_new_random_seed = False
    sc.MPFB_RAND_skin_type = "GAMEENGINE"
    sc.MPFB_RAND_asset_material_type = "GAMEENGINE"
    sc.MPFB_RAND_eyes_material_type = "GAMEENGINE"
    sc.MPFB_RAND_add_subdiv_modifier = False
    sc.MPFB_RAND_age_allow_baby = False
    sc.MPFB_RAND_age_allow_child = False
    sc.MPFB_RAND_age_allow_old = False
    sc.MPFB_RAND_gender_allow_male = gender == "male"
    sc.MPFB_RAND_gender_allow_female = gender == "female"
    sc.MPFB_RAND_teeth_enable = False
    sc.MPFB_RAND_tongue_enable = False
    sc.MPFB_RAND_add_rig = "mixamo"
    sc.MPFB_RAND_clothes_full_body_chance = 100
    sc.MPFB_RAND_clothes_full_body_exclude = "elegant"
    bpy.ops.mpfb.create_random_human()
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for m in meshes:
        if any(k in m.name for k in ("teeth", "tongue")):
            bpy.data.objects.remove(m)
    return rig, [o for o in bpy.data.objects if o.type == "MESH"]

def hips_height(arm):
    return (arm.matrix_world @ arm.data.bones["mixamorig:Hips"].head_local).z

def retarget(rig, fbx, name):
    for pb in rig.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=fbx)
    new = [o for o in bpy.data.objects if o not in before]
    source = next(o for o in new if o.type == "ARMATURE")
    for o in new:
        if o.type == "MESH":
            bpy.data.objects.remove(o)
    source.scale *= hips_height(rig) / hips_height(source)
    bpy.context.view_layer.update()
    action = source.animation_data.action
    start, end = map(int, action.frame_range)
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.mpfb.map_mixamo()
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(frame_start=start, frame_end=end, step=2, only_selected=False, visual_keying=True,
                     clear_constraints=True, use_current_action=False, bake_types={"POSE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    baked = rig.animation_data.action
    baked.name = name
    baked.use_fake_user = True
    bpy.data.objects.remove(source)
    bpy.data.actions.remove(action)
    return baked

def lighten(meshes, ratio):
    for m in meshes:
        if m.name == "Human":
            m.modifiers.new("dec", "DECIMATE").ratio = ratio
    for image in bpy.data.images:
        if image.size[0] > texture_size:
            image.scale(texture_size, texture_size)

def tris(meshes):
    return sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)

if "pilote" not in sys.argv[sys.argv.index("--") + 3:]:
    for index, (seed, gender) in enumerate(spectators):
        reset()
        rig, meshes = create_human(seed, gender)
        for file, name in clips.items():
            retarget(rig, f"{src}/{file}.fbx", name)
        for action in list(bpy.data.actions):
            if action.name not in clips.values():
                bpy.data.actions.remove(action)
        rig.animation_data.action = bpy.data.actions["idle"]
        lighten(meshes, 0.3)
        path = f"{out}/spectateur_{index}.glb"
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_animation_mode="ACTIONS",
                                  export_force_sampling=True, export_morph=False)
        print("PERSON", index, gender, "base tris", tris(meshes), "KB", os.path.getsize(path) // 1024)

def place(name, location):
    empty = bpy.data.objects.new(name, None)
    empty.location = location
    bpy.context.scene.collection.objects.link(empty)
    return empty

def seat_pose(rig):
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    rig.pose.bones["mixamorig:Spine"].rotation_mode = "XYZ"
    rig.pose.bones["mixamorig:Spine"].rotation_euler.x = math.radians(-8)
    limbs = {
        "LeftForeArm": ((0.17, -0.47, 1.09), (0.6, 0.13, 0.45)),
        "RightForeArm": ((-0.17, -0.47, 1.09), (-0.6, 0.13, 0.45)),
        "LeftLeg": ((0.15, -0.99, 0.48), (0.2, -0.77, 1.75)),
        "RightLeg": ((-0.13, -0.99, 0.48), (-0.15, -0.77, 1.75)),
    }
    for bone, (target, pole) in limbs.items():
        ik = rig.pose.bones[f"mixamorig:{bone}"].constraints.new("IK")
        ik.target = place(f"{bone}_target", target)
        ik.pole_target = place(f"{bone}_pole", pole)
        ik.pole_angle = math.radians(-90)
        ik.chain_count = 2
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

def head_ends(rig):
    bone = rig.pose.bones["mixamorig:Head"]
    return rig.matrix_world @ bone.head, rig.matrix_world @ bone.tail

def add_helmet(rig):
    head, top = head_ends(rig)
    center, size = (head + top) / 2, (top - head).length
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=size * 0.58, location=center)
    helmet = bpy.context.active_object
    helmet.name = "casque"
    helmet.data.materials.append(shiny("casque", (0.9, 0.9, 0.9), 0.15, 0.0))
    bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=size * 0.5, location=center + Vector((0, -1, 0)) * size * 0.5)
    visor = bpy.context.active_object
    visor.name = "visiere"
    visor.scale = (0.85, 0.3, 0.42)
    visor.data.materials.append(shiny("visiere", (0.02, 0.02, 0.03), 0.05, 0.9))
    bpy.ops.object.shade_smooth()
    return [helmet, visor]

def shiny(name, color, roughness, metallic):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat

def add_wheel():
    bpy.ops.mesh.primitive_torus_add(major_radius=0.19, minor_radius=0.018, location=(0, -0.49, 1.07), rotation=(math.radians(65), 0, 0))
    wheel = bpy.context.active_object
    wheel.name = "volant"
    wheel.data.materials.append(shiny("volant", (0.02, 0.02, 0.02), 0.9, 0.0))
    return wheel

def bake_pose(meshes):
    for m in meshes:
        bpy.context.view_layer.objects.active = m
        if m.data.shape_keys:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for mod in list(m.modifiers):
            if mod.type == "ARMATURE":
                bpy.ops.object.modifier_apply(modifier=mod.name)
        world = m.matrix_world.copy()
        m.parent = None
        m.matrix_world = world

reset()
rig, meshes = create_human(97, "male")
for m in [m for m in meshes if any(k in m.name.lower() for k in ("braid", "hair", "eyebrow"))]:
    bpy.data.objects.remove(m)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
seat_pose(rig)
extras = add_helmet(rig)
extras.append(add_wheel())
lighten(meshes, 0.4)
bake_pose(meshes)
for o in [o for o in bpy.data.objects if o.type in ("ARMATURE", "EMPTY")]:
    bpy.data.objects.remove(o)
path = f"{out}/pilote.glb"
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_animations=False, export_skins=False, export_morph=False)
print("DRIVER base tris", tris(meshes), "KB", os.path.getsize(path) // 1024, [m.name for m in meshes])
