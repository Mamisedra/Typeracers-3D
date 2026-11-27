import bpy, sys, math, os
from mathutils import Vector, Matrix

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
cars = {
    "Hatchback Body": ("rallye", 4.2),
    "Sport body": ("coupe", 4.4),
    "Pickup Body": ("pickup", 5.2),
    "Offroad Body": ("buggy", 4.4),
}

def mesh_children(obj):
    return [c for c in obj.children_recursive if c.type == "MESH"]

def world_bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    return Vector([min(p[i] for p in pts) for i in range(3)]), Vector([max(p[i] for p in pts) for i in range(3)])

for body_name, (name, length) in cars.items():
    bpy.ops.wm.open_mainfile(filepath=src)
    body = bpy.data.objects[body_name]
    wheel_roots = [o for o in bpy.data.objects if o.type == "EMPTY" and o.name.startswith("Wheel_") and mesh_children(o)
                   and (o.matrix_world.translation - body.matrix_world.translation).length < 4.5]
    front = -body.matrix_world.to_3x3().col[2].normalized()
    angle = -math.pi / 2 - math.atan2(front.y, front.x)
    keep = mesh_children(body) + [m for w in wheel_roots for m in mesh_children(w)]
    wheel_meshes = {m for w in wheel_roots for m in mesh_children(w)}
    worlds = {m: m.matrix_world.copy() for m in keep}
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    for m in keep:
        m.parent = None
        m.matrix_world = worlds[m]
    centre = sum((m.matrix_world.translation for m in wheel_meshes), Vector()) / len(wheel_meshes)
    align = Matrix.Rotation(angle, 4, "Z") @ Matrix.Translation(-centre)
    for m in keep:
        m.matrix_world = align @ m.matrix_world
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = keep[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn, mx = world_bounds(keep)
    scale = length / (mx.y - mn.y)
    lift = -mn.z * scale
    for m in keep:
        m.matrix_world = Matrix.Translation((0, 0, lift)) @ Matrix.Scale(scale, 4) @ m.matrix_world
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    body_parts = [m for m in keep if m not in wheel_meshes]
    bpy.ops.object.select_all(action="DESELECT")
    for m in body_parts:
        m.select_set(True)
    bpy.context.view_layer.objects.active = body_parts[0]
    bpy.ops.object.join()
    bpy.context.active_object.name = "body"
    for slot in bpy.context.active_object.material_slots:
        mat = slot.material
        kind = next(k for k in ("Body", "Glass", "Optics") if mat.name.startswith(k) or k in mat.name)
        mat.name = {"Body": "paint", "Glass": "glass", "Optics": "optics"}[kind]
        if kind == "Body":
            image = next(n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and "baseColor" in n.image.name)
            px = list(image.pixels)
            lum = [0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] for i in range(0, len(px), 4)]
            paint = sorted(lum)[int(len(lum) * 0.6)] or 1
            for j, l in enumerate(lum):
                g = min(1.0, l / paint * 0.9)
                px[j * 4:j * 4 + 3] = (g, g, g)
            image.pixels = px
            image.pack()

    for m in wheel_meshes:
        bpy.ops.object.select_all(action="DESELECT")
        m.select_set(True)
        bpy.context.view_layer.objects.active = m
        bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
        p = m.location
        m.name = f"wheel_{'f' if p.y < 0 else 'r'}{'l' if p.x > 0 else 'r'}"
        m.data.name = m.name
        for slot in m.material_slots:
            slot.material.name = "wheel"

    mn, mx = world_bounds(list(bpy.data.objects))
    print("CAR", name, "size", tuple(round(v, 2) for v in mx - mn), "objects", sorted(o.name for o in bpy.data.objects),
          "faces", sum(len(o.data.polygons) for o in bpy.data.objects))
    bpy.ops.export_scene.gltf(filepath=f"{out}/voiture_{name}.glb", export_format="GLB", export_image_format="WEBP", export_animations=False)
    print("FILE", name, os.path.getsize(f"{out}/voiture_{name}.glb") // 1024, "KB")
