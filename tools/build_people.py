import bpy, sys, os

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

reset()
rig, meshes = create_human(97, "male")
retarget(rig, f"{src}/Driving.fbx", "driving")
bpy.context.scene.frame_set(40)
lighten(meshes, 0.4)
path = f"{out}/pilote.glb"
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_animations=False, export_skins=False, export_morph=False)
print("DRIVER base tris", tris(meshes), "KB", os.path.getsize(path) // 1024)
