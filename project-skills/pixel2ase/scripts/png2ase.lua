-- png -> indexed .aseprite with palette built from the image
-- usage:
--   aseprite.exe -b --script-param in=t_native.png --script-param out=t_native.aseprite --script png2ase.lua
-- optional: --script-param mode=rgb   (keep RGB, only attach palette)
local inFile  = app.params["in"]
assert(inFile, "missing --script-param in=<input.png>")
local outFile = app.params["out"] or (inFile:gsub("%.png$", "") .. ".aseprite")
local mode    = app.params["mode"] or "indexed"

local spr = app.open(inFile)
assert(spr, "cannot open " .. inFile)

-- build palette from actual image colors
local plt = Palette{ fromSprite = spr }   -- may fail to capture all; rebuild manually
local img = spr.cels[1].image
local seen, colors = {}, {}
for it in img:pixels() do
  local v = it()
  local a = app.pixelColor.rgbaA(v)
  if a > 0 then
    local key = app.pixelColor.rgba(
      app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v), 255)
    if not seen[key] then
      seen[key] = true
      colors[#colors + 1] = key
    end
  end
end
table.sort(colors)
print("unique colors: " .. #colors)
assert(#colors <= 256, "more than 256 colors; quantize first (pipeline.py --colors N)")

plt = Palette(#colors)
for i, v in ipairs(colors) do
  plt:setColor(i - 1, Color{
    r = app.pixelColor.rgbaR(v),
    g = app.pixelColor.rgbaG(v),
    b = app.pixelColor.rgbaB(v), a = 255 })
end
spr:setPalette(plt)

if mode == "indexed" then
  app.command.ChangePixelFormat{ format = "indexed", dithering = "none" }
end

spr:saveAs(outFile)
print("saved " .. outFile .. " (" .. spr.width .. "x" .. spr.height ..
      ", " .. mode .. ", " .. #colors .. " colors)")
