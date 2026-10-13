from pathlib import Path
import math
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
RENDERS = OUTPUT / "renders"
OUTPUT.mkdir(parents=True, exist_ok=True)
RENDERS.mkdir(parents=True, exist_ok=True)


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.curves, bpy.data.armatures):
        for item in list(datablocks):
            if item.users == 0:
                datablocks.remove(item)


reset_scene()
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.eevee.taa_samples = 24
scene.eevee.taa_render_samples = 24
scene.render.resolution_x = 600
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.render.image_settings.color_mode = "RGBA"
scene.world.use_nodes = True
world_background = scene.world.node_tree.nodes.get("Background")
world_background.inputs["Color"].default_value = (0.78, 0.87, 0.98, 1.0)
world_background.inputs["Strength"].default_value = 0.55
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass

model_collection = bpy.data.collections.new("ZX_Fox_Model")
preview_collection = bpy.data.collections.new("ZX_Fox_Preview")
scene.collection.children.link(model_collection)
scene.collection.children.link(preview_collection)


def move_to(obj, collection):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def principled_material(name, color, roughness=0.55, metallic=0.0, fur=False, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.12 if not fur else 0.03
    if fur:
        noise = nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 42.0
        noise.inputs["Detail"].default_value = 3.0
        noise.inputs["Roughness"].default_value = 0.72
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.14
        bump.inputs["Distance"].default_value = 0.025
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


WHITE = principled_material("Fur_Warm_White", (0.965, 0.94, 0.88), 0.82, fur=True)
LIGHT_FUR = principled_material("Fur_Soft_White", (0.985, 0.98, 0.94), 0.78, fur=True)
BLUE = principled_material("ZX_Tech_Blue", (0.035, 0.30, 0.95), 0.42, metallic=0.04)
CYAN = principled_material("ZX_Cyan", (0.12, 0.58, 1.0), 0.38, metallic=0.03)
NAVY = principled_material("ZX_Deep_Navy", (0.012, 0.035, 0.095), 0.36)
BLACK = principled_material("Eye_Black", (0.004, 0.008, 0.018), 0.2)
SILVER = principled_material("Suit_Silver", (0.72, 0.78, 0.84), 0.48, metallic=0.18)
GROUND = principled_material("Preview_Ground", (0.92, 0.96, 1.0), 0.92)
GLASS = principled_material("Goggle_Glass", (0.18, 0.62, 1.0), 0.12, metallic=0.02, alpha=0.30)
GLASS.surface_render_method = "DITHERED"
glass_bsdf = GLASS.node_tree.nodes.get("Principled BSDF")
if "Transmission Weight" in glass_bsdf.inputs:
    glass_bsdf.inputs["Transmission Weight"].default_value = 0.28
if "IOR" in glass_bsdf.inputs:
    glass_bsdf.inputs["IOR"].default_value = 1.38

parts = {name: [] for name in ("root", "body", "head", "ear.L", "ear.R", "arm.L", "arm.R", "leg.L", "leg.R", "tail.01", "tail.02", "tail.03")}


def register(obj, bone="body"):
    move_to(obj, model_collection)
    parts[bone].append(obj)
    return obj


def smooth(obj):
    if obj.type == "MESH":
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def apply_modifier(obj, modifier):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def uv_sphere(name, location, scale, material, bone="body", segments=36, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    smooth(obj)
    return register(obj, bone)


def rounded_cube(name, location, scale, material, bone="body", bevel=0.08, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    mod = obj.modifiers.new("Soft_Edges", "BEVEL")
    mod.width = bevel
    mod.segments = 4
    apply_modifier(obj, mod)
    obj.data.materials.append(material)
    smooth(obj)
    return register(obj, bone)


def torus(name, location, major_radius, minor_radius, material, bone="body", rotation=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=48,
        minor_segments=12,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    smooth(obj)
    return register(obj, bone)


def cone_tuft(name, location, radius, depth, material, bone="head", rotation=(0, 0, 0), vertices=5, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=0.015, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = obj.modifiers.new("Tuft_Soften", "BEVEL")
    bevel.width = radius * 0.14
    bevel.segments = 2
    apply_modifier(obj, bevel)
    obj.data.materials.append(material)
    smooth(obj)
    return register(obj, bone)


def ear_mesh(name, x, width, height, depth, z, material, bone, front=-0.05):
    verts = [
        (-width / 2, -depth / 2, 0),
        (width / 2, -depth / 2, 0),
        (0, -depth * 0.05, height),
        (-width / 2, depth / 2, 0),
        (width / 2, depth / 2, 0),
        (0, depth * 0.05, height),
    ]
    faces = [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    model_collection.objects.link(obj)
    obj.location = (x, front, z)
    obj.data.materials.append(material)
    bevel = obj.modifiers.new("Ear_Soften", "BEVEL")
    bevel.width = min(width, depth) * 0.16
    bevel.segments = 4
    apply_modifier(obj, bevel)
    smooth(obj)
    parts[bone].append(obj)
    return obj


def layered_ear_mesh(name, x, width, height, depth, z, bone, tip_height=0.30, front=0.03):
    tip_z = height - tip_height
    tip_width = width * tip_height / height
    tip_depth = depth * tip_height / height
    verts = [
        (-width / 2, -depth / 2, 0),
        (width / 2, -depth / 2, 0),
        (-width / 2, depth / 2, 0),
        (width / 2, depth / 2, 0),
        (-tip_width / 2, -tip_depth / 2, tip_z),
        (tip_width / 2, -tip_depth / 2, tip_z),
        (-tip_width / 2, tip_depth / 2, tip_z),
        (tip_width / 2, tip_depth / 2, tip_z),
        (0, -depth * 0.05, height),
        (0, depth * 0.05, height),
    ]
    faces = [
        (0, 1, 5, 4),
        (3, 2, 6, 7),
        (0, 4, 6, 2),
        (1, 3, 7, 5),
        (0, 2, 3, 1),
        (4, 5, 8),
        (7, 6, 9),
        (4, 8, 9, 6),
        (5, 7, 9, 8),
    ]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    model_collection.objects.link(obj)
    obj.location = (x, front, z)
    obj.data.materials.append(WHITE)
    obj.data.materials.append(BLUE)
    for polygon in obj.data.polygons:
        polygon.material_index = 1 if polygon.index >= 5 else 0
    bevel = obj.modifiers.new("Ear_Soften", "BEVEL")
    bevel.width = min(width, depth) * 0.14
    bevel.segments = 4
    apply_modifier(obj, bevel)
    smooth(obj)
    parts[bone].append(obj)
    return obj


def rounded_rect_points(width, height, radius, segments=7):
    points = []
    corners = (
        (width / 2 - radius, height / 2 - radius, 0),
        (-width / 2 + radius, height / 2 - radius, 90),
        (-width / 2 + radius, -height / 2 + radius, 180),
        (width / 2 - radius, -height / 2 + radius, 270),
    )
    for cx, cz, start in corners:
        for step in range(segments + 1):
            angle = math.radians(start + step * 90 / segments)
            points.append((cx + radius * math.cos(angle), cz + radius * math.sin(angle)))
    return points


def rounded_rect_solid(name, location, width, height, radius, depth, material, bone="head"):
    points = rounded_rect_points(width, height, radius)
    verts = [(x, -depth / 2, z) for x, z in points] + [(x, depth / 2, z) for x, z in points]
    count = len(points)
    faces = [tuple(range(count)), tuple(range(count, count * 2))[::-1]]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    model_collection.objects.link(obj)
    obj.location = location
    obj.data.materials.append(material)
    bevel = obj.modifiers.new("Lens_Edge_Soften", "BEVEL")
    bevel.width = 0.018
    bevel.segments = 2
    apply_modifier(obj, bevel)
    smooth(obj)
    parts[bone].append(obj)
    return obj


def rounded_rect_frame(name, location, width, height, radius, thickness, material, bone="head"):
    points = rounded_rect_points(width, height, radius)
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = thickness
    curve.bevel_resolution = 3
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, (x, z) in zip(spline.points, points):
        point.co = (x, 0, z, 1)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, curve)
    model_collection.objects.link(obj)
    obj.location = location
    obj.data.materials.append(material)
    parts[bone].append(obj)
    return obj


# Body and suit
uv_sphere("Torso_Fur", (0, 0.02, 1.12), (0.62, 0.48, 0.82), WHITE, "body")
uv_sphere("Jacket_Blue_Shell", (0, -0.025, 1.18), (0.67, 0.50, 0.60), BLUE, "body")
uv_sphere("Jacket_White_Front", (0, -0.47, 1.20), (0.36, 0.075, 0.54), LIGHT_FUR, "body")
rounded_cube("Jacket_Zipper", (0, -0.555, 1.18), (0.024, 0.025, 0.43), NAVY, "body", 0.012)
rounded_cube("Collar_L", (-0.18, -0.49, 1.68), (0.22, 0.07, 0.09), LIGHT_FUR, "body", 0.04, rotation=(math.radians(12), 0, math.radians(-20)))
rounded_cube("Collar_R", (0.18, -0.49, 1.68), (0.22, 0.07, 0.09), LIGHT_FUR, "body", 0.04, rotation=(math.radians(12), 0, math.radians(20)))
rounded_cube("Badge_Base", (0.27, -0.56, 1.33), (0.18, 0.025, 0.14), LIGHT_FUR, "body", 0.04)
rounded_cube("Badge_Z", (0.235, -0.592, 1.35), (0.07, 0.014, 0.022), BLUE, "body", 0.01)
rounded_cube("Badge_X", (0.31, -0.592, 1.35), (0.055, 0.014, 0.022), CYAN, "body", 0.01, rotation=(0, 0, math.radians(35)))
rounded_cube("Suit_Trim_L", (-0.43, -0.45, 1.16), (0.035, 0.028, 0.31), CYAN, "body", 0.015, rotation=(0, 0, math.radians(-5)))
rounded_cube("Suit_Trim_R", (0.43, -0.45, 1.16), (0.035, 0.028, 0.31), CYAN, "body", 0.015, rotation=(0, 0, math.radians(5)))

# Head silhouette and fur tufts
uv_sphere("Head_Fur", (0, 0, 2.35), (1.02, 0.72, 0.84), WHITE, "head")
uv_sphere("Cheek_L", (-0.74, -0.48, 2.22), (0.42, 0.31, 0.29), LIGHT_FUR, "head")
uv_sphere("Cheek_R", (0.74, -0.48, 2.22), (0.42, 0.31, 0.29), LIGHT_FUR, "head")
cone_tuft("Cheek_Blue_L", (-1.0, -0.44, 2.23), 0.23, 0.46, BLUE, "head", rotation=(0, math.radians(-90), 0), scale=(1.0, 0.72, 1.0))
cone_tuft("Cheek_Blue_R", (1.0, -0.44, 2.23), 0.23, 0.46, BLUE, "head", rotation=(0, math.radians(90), 0), scale=(1.0, 0.72, 1.0))
for index, (x, z, angle, size) in enumerate(((-0.27, 2.95, -18, 0.28), (0, 3.02, 0, 0.34), (0.27, 2.95, 18, 0.27))):
    cone_tuft(f"Forehead_Tuft_{index}", (x, -0.39, z), size, size * 1.6, LIGHT_FUR, "head", rotation=(0, 0, math.radians(angle)), scale=(0.72, 0.52, 1.0))

# White ear volumes keep the rear view faithful; the blue cap follows the natural taper.
layered_ear_mesh("Ear_L", -0.54, 0.66, 1.18, 0.42, 2.88, "ear.L")
layered_ear_mesh("Ear_R", 0.54, 0.66, 1.18, 0.42, 2.88, "ear.R")
ear_mesh("Inner_Ear_L", -0.54, 0.27, 0.56, 0.08, 3.08, CYAN, "ear.L", front=-0.27)
ear_mesh("Inner_Ear_R", 0.54, 0.27, 0.56, 0.08, 3.08, CYAN, "ear.R", front=-0.27)

# Eyes, muzzle and the single transparent visor.
for side, x in (("L", -0.34), ("R", 0.34)):
    uv_sphere(f"Eye_White_{side}", (x, -0.69, 2.42), (0.25, 0.105, 0.32), LIGHT_FUR, "head")
    uv_sphere(f"Eye_Iris_{side}", (x, -0.785, 2.42), (0.16, 0.055, 0.23), CYAN, "head")
    uv_sphere(f"Eye_Pupil_{side}", (x, -0.835, 2.41), (0.085, 0.028, 0.16), BLACK, "head")
    uv_sphere(f"Eye_Highlight_{side}", (x - 0.04, -0.865, 2.50), (0.036, 0.014, 0.055), LIGHT_FUR, "head", segments=24, rings=16)
    rounded_cube(f"Brow_{side}", (x, -0.70, 2.82), (0.17, 0.03, 0.025), NAVY, "head", 0.018, rotation=(0, 0, math.radians(6 if side == "L" else -6)))

rounded_rect_solid("Goggle_Lens", (0, -0.88, 2.44), 1.78, 0.59, 0.17, 0.075, GLASS, "head")
rounded_rect_frame("Goggle_Frame", (0, -0.94, 2.44), 1.80, 0.61, 0.18, 0.036, BLUE, "head")
rounded_cube("Goggle_Bridge", (0, -0.965, 2.44), (0.025, 0.025, 0.22), BLUE, "head", 0.018)
rounded_cube("Goggle_Strap_L", (-1.03, -0.45, 2.43), (0.15, 0.04, 0.045), BLUE, "head", 0.025, rotation=(0, math.radians(18), 0))
rounded_cube("Goggle_Strap_R", (1.03, -0.45, 2.43), (0.15, 0.04, 0.045), BLUE, "head", 0.025, rotation=(0, math.radians(-18), 0))
uv_sphere("Muzzle", (0, -0.72, 2.04), (0.38, 0.22, 0.23), LIGHT_FUR, "head")
uv_sphere("Nose", (0, -0.92, 2.12), (0.10, 0.06, 0.065), NAVY, "head", segments=32, rings=20)
rounded_cube("Mouth", (0, -0.925, 1.96), (0.12, 0.02, 0.018), NAVY, "head", 0.014)

# Limbs and wearable details
for side, x, bone in (("L", -0.68, "arm.L"), ("R", 0.68, "arm.R")):
    uv_sphere(f"Arm_{side}", (x, -0.02, 1.20), (0.22, 0.22, 0.55), LIGHT_FUR, bone)
    torus(f"Cuff_{side}", (x, -0.10, 0.89), 0.17, 0.035, BLUE, bone, rotation=(math.radians(90), 0, 0), scale=(1, 1, 0.85))
    uv_sphere(f"Glove_{side}", (x, -0.13, 0.74), (0.26, 0.23, 0.24), WHITE, bone)

rounded_cube("Wrist_Device", (0.71, -0.36, 1.07), (0.16, 0.055, 0.12), NAVY, "arm.R", 0.05)
rounded_cube("Wrist_Screen", (0.71, -0.42, 1.08), (0.10, 0.012, 0.07), CYAN, "arm.R", 0.025)

for side, x, bone in (("L", -0.27, "leg.L"), ("R", 0.27, "leg.R")):
    uv_sphere(f"Leg_{side}", (x, 0.01, 0.42), (0.22, 0.24, 0.42), LIGHT_FUR, bone)
    uv_sphere(f"Boot_{side}", (x, -0.16, 0.18), (0.34, 0.42, 0.19), BLUE, bone)
    rounded_cube(f"Boot_Trim_{side}", (x, -0.47, 0.20), (0.22, 0.035, 0.035), LIGHT_FUR, bone, 0.02)

# The tail is intentionally nearly as large as the body, matching the reference silhouette.
tail_specs = [
    ("Tail_Base", (0.64, 0.18, 0.98), (0.48, 0.48, 0.56), WHITE, "tail.01"),
    ("Tail_White_Mass", (1.22, 0.18, 1.13), (1.02, 0.62, 0.78), LIGHT_FUR, "tail.02"),
    ("Tail_Tip_Blue", (1.89, 0.17, 1.26), (0.64, 0.57, 0.70), BLUE, "tail.03"),
]
for spec in tail_specs:
    uv_sphere(*spec)
cone_tuft("Tail_Tip_Point", (2.24, 0.16, 1.28), 0.34, 0.74, BLUE, "tail.03", rotation=(0, math.radians(90), 0), scale=(1, 0.9, 1.05))
for index, (x, z, angle) in enumerate(((1.52, 1.56, 18), (1.67, 1.62, 4), (1.82, 1.57, -14))):
    cone_tuft(f"Tail_Blue_Tuft_{index}", (x, -0.34, z), 0.20, 0.42, BLUE, "tail.03", rotation=(math.radians(90), 0, math.radians(angle)), scale=(1, 0.62, 1))


def create_rig():
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    rig = bpy.context.object
    rig.name = "ZX_Fox_Rig"
    move_to(rig, model_collection)
    armature = rig.data
    armature.name = "ZX_Fox_Armature"
    root = armature.edit_bones[0]
    root.name = "root"
    root.head = (0, 0, 0)
    root.tail = (0, 0, 0.45)
    root.use_deform = False

    def bone(name, head, tail, parent):
        item = armature.edit_bones.new(name)
        item.head = head
        item.tail = tail
        item.parent = armature.edit_bones[parent]
        item.use_deform = False
        return item

    bone("body", (0, 0, 0.45), (0, 0, 1.75), "root")
    bone("head", (0, 0, 1.75), (0, 0, 2.86), "body")
    bone("ear.L", (-0.54, 0, 2.86), (-0.54, 0, 3.92), "head")
    bone("ear.R", (0.54, 0, 2.86), (0.54, 0, 3.92), "head")
    bone("arm.L", (-0.48, 0, 1.55), (-0.72, 0, 0.75), "body")
    bone("arm.R", (0.48, 0, 1.55), (0.72, 0, 0.75), "body")
    bone("leg.L", (-0.27, 0, 0.78), (-0.27, 0, 0.10), "root")
    bone("leg.R", (0.27, 0, 0.78), (0.27, 0, 0.10), "root")
    bone("tail.01", (0.48, 0.15, 1.03), (1.02, 0.17, 1.08), "body")
    bone("tail.02", (1.02, 0.17, 1.08), (1.55, 0.17, 1.18), "tail.01")
    bone("tail.03", (1.55, 0.17, 1.18), (2.22, 0.16, 1.27), "tail.02")
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.show_in_front = True
    rig.data.display_type = "OCTAHEDRAL"
    return rig


rig = create_rig()


def parent_to_bone(obj, bone_name):
    world = obj.matrix_world.copy()
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    obj.matrix_world = world


for bone_name, objects in parts.items():
    for obj in objects:
        parent_to_bone(obj, bone_name)


def reset_pose():
    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "XYZ"
        pose_bone.rotation_euler = (0, 0, 0)
        pose_bone.location = (0, 0, 0)
        pose_bone.scale = (1, 1, 1)


def make_action(name, end_frame, poses):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = action
    for frame, values in poses:
        reset_pose()
        for bone_name, transforms in values.items():
            pose_bone = rig.pose.bones[bone_name]
            if "rotation" in transforms:
                pose_bone.rotation_euler = transforms["rotation"]
            if "location" in transforms:
                pose_bone.location = transforms["location"]
            if "scale" in transforms:
                pose_bone.scale = transforms["scale"]
        for pose_bone in rig.pose.bones:
            pose_bone.keyframe_insert("rotation_euler", frame=frame, group=pose_bone.name)
            pose_bone.keyframe_insert("location", frame=frame, group=pose_bone.name)
            pose_bone.keyframe_insert("scale", frame=frame, group=pose_bone.name)
    action.frame_range = (1, end_frame)
    for fcurve in action.fcurves:
        for point in fcurve.keyframe_points:
            point.interpolation = "BEZIER"
    rig.animation_data.action = None
    return action


actions = [
    make_action("Idle", 60, [
        (1, {}),
        (30, {"body": {"scale": (1.0, 1.0, 1.025)}, "head": {"rotation": (0.0, 0.0, math.radians(1.8))}, "tail.03": {"rotation": (0, math.radians(6), 0)}}),
        (60, {}),
    ]),
    make_action("Wave", 48, [
        (1, {}),
        (10, {"arm.R": {"rotation": (math.radians(-18), math.radians(-20), math.radians(105))}, "head": {"rotation": (0, 0, math.radians(-5))}}),
        (20, {"arm.R": {"rotation": (math.radians(10), math.radians(-15), math.radians(78))}, "head": {"rotation": (0, 0, math.radians(-5))}}),
        (30, {"arm.R": {"rotation": (math.radians(-16), math.radians(-20), math.radians(108))}, "head": {"rotation": (0, 0, math.radians(-5))}}),
        (40, {"arm.R": {"rotation": (math.radians(8), math.radians(-15), math.radians(80))}}),
        (48, {}),
    ]),
    make_action("Cheer", 42, [
        (1, {}),
        (14, {"arm.L": {"rotation": (0, 0, math.radians(-105))}, "arm.R": {"rotation": (0, 0, math.radians(105))}, "root": {"location": (0, 0, 0.12)}, "tail.02": {"rotation": (0, math.radians(9), math.radians(5))}}),
        (26, {"arm.L": {"rotation": (0, 0, math.radians(-92))}, "arm.R": {"rotation": (0, 0, math.radians(92))}, "root": {"location": (0, 0, 0.04)}}),
        (42, {}),
    ]),
    make_action("Think", 60, [
        (1, {}),
        (24, {"head": {"rotation": (math.radians(-4), 0, math.radians(9))}, "arm.R": {"rotation": (math.radians(-22), math.radians(-14), math.radians(58))}, "ear.L": {"rotation": (0, math.radians(-5), math.radians(-4))}}),
        (44, {"head": {"rotation": (math.radians(-4), 0, math.radians(7))}, "arm.R": {"rotation": (math.radians(-22), math.radians(-14), math.radians(58))}}),
        (60, {}),
    ]),
    make_action("Sleep", 90, [
        (1, {}),
        (30, {"head": {"rotation": (math.radians(15), 0, math.radians(7))}, "body": {"rotation": (0, 0, math.radians(2))}, "ear.L": {"rotation": (0, math.radians(10), 0)}, "ear.R": {"rotation": (0, math.radians(-10), 0)}}),
        (60, {"head": {"rotation": (math.radians(17), 0, math.radians(5))}, "body": {"rotation": (0, 0, math.radians(1))}}),
        (90, {"head": {"rotation": (math.radians(15), 0, math.radians(7))}, "body": {"rotation": (0, 0, math.radians(2))}}),
    ]),
    make_action("Jump", 42, [
        (1, {}),
        (12, {"root": {"location": (0, 0, -0.05), "scale": (1.04, 1.04, 0.94)}}),
        (24, {"root": {"location": (0, 0, 0.30), "scale": (0.97, 0.97, 1.04)}, "arm.L": {"rotation": (0, 0, math.radians(-24))}, "arm.R": {"rotation": (0, 0, math.radians(24))}}),
        (34, {"root": {"location": (0, 0, -0.025), "scale": (1.025, 1.025, 0.97)}}),
        (42, {}),
    ]),
]
reset_pose()

rig["character_name"] = "ZX Fox"
rig["design_reference"] = "zx-blue-fox-character-sheet"
rig["appearance_policy"] = "single-fixed-blue-white-character"
rig["work_modes"] = "beginner,veteran,qa"
rig["animation_names"] = ",".join(action.name for action in actions)


def add_preview_scene():
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, -0.015))
    ground = bpy.context.object
    ground.name = "Preview_Ground"
    move_to(ground, preview_collection)
    ground.data.materials.append(GROUND)

    def area(name, location, energy, size, color):
        data = bpy.data.lights.new(name=name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        preview_collection.objects.link(obj)
        obj.location = location
        look_at(obj, (0, 0, 1.8))
        return obj

    area("Key_Light", (-4.5, -5.5, 7.0), 1250, 4.0, (1.0, 0.96, 0.90))
    area("Fill_Light", (4.5, -3.0, 4.2), 900, 3.2, (0.68, 0.82, 1.0))
    area("Rim_Light", (2.5, 4.0, 5.5), 1100, 3.0, (0.18, 0.52, 1.0))

    camera_data = bpy.data.cameras.new("Preview_Camera")
    camera = bpy.data.objects.new("Preview_Camera", camera_data)
    preview_collection.objects.link(camera)
    camera.data.lens = 62
    scene.camera = camera
    return camera


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


camera = add_preview_scene()


def render_view(name, location, target=(0.35, 0, 1.95)):
    camera.location = location
    look_at(camera, target)
    scene.render.filepath = str(RENDERS / f"{name}.png")
    bpy.ops.render.render(write_still=True)


blend_path = OUTPUT / "zx-fox.blend"
glb_path = OUTPUT / "zx-fox.glb"
bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

for obj in bpy.context.selected_objects:
    obj.select_set(False)
for obj in model_collection.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig

bpy.ops.export_scene.gltf(
    filepath=str(glb_path),
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_materials="EXPORT",
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_extra_animations=True,
    export_anim_single_armature=True,
    export_force_sampling=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
    export_extras=True,
)

render_view("front", (0.25, -8.8, 2.35))
render_view("three-quarter", (6.4, -7.2, 2.75))
render_view("side", (8.8, 0.0, 2.35), target=(0.55, 0, 1.95))
render_view("back", (0.25, 8.8, 2.35))

mesh_objects = [obj for obj in model_collection.objects if obj.type == "MESH"]
for obj in mesh_objects:
    obj.data.calc_loop_triangles()
triangles = sum(len(obj.data.loop_triangles) for obj in mesh_objects)
print(f"ZX_FOX_COMPLETE blend={blend_path}")
print(f"ZX_FOX_COMPLETE glb={glb_path}")
print(f"ZX_FOX_STATS objects={len(model_collection.objects)} meshes={len(mesh_objects)} triangles={triangles} actions={len(actions)}")
