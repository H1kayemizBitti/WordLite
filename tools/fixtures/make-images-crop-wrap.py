# -*- coding: utf-8 -*-
"""用 Word COM 生成 tools/fixtures/images-crop-wrap.docx（V3 验收样本）。
包含：四边都裁剪的图、上下型（左/中/右）、四周型、表格单元格里的图、紧密型。
"""
import os
import sys
import win32com.client as win32

ROOT = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(ROOT, 'images-crop-wrap.docx')
LAB = r'C:\Users\25487\Desktop\AITest\_tmp\v3work'
PNG = os.path.join(LAB, 'crop-test.png')

wdWrapSquare = 0
wdWrapTight = 1
wdWrapTopBottom = 4
wdShapeLeft = -999998
wdShapeCenter = -999995
wdShapeRight = -999996
wdRelHColumn = 2
wdRelVParagraph = 2


def source_png():
    if os.path.exists(PNG):
        return
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (800, 600), 'white')
    d = ImageDraw.Draw(img)
    band = 40
    d.rectangle([0, 0, 799, band - 1], fill=(220, 40, 40))
    d.rectangle([0, 599 - band + 1, 799, 599], fill=(40, 140, 220))
    d.rectangle([0, 0, band - 1, 599], fill=(40, 160, 80))
    d.rectangle([799 - band + 1, 0, 799, 599], fill=(230, 180, 30))
    for x in range(0, 800, 100):
        d.line([(x, 0), (x, 600)], fill=(200, 200, 200))
    for y in range(0, 600, 100):
        d.line([(0, y), (800, y)], fill=(200, 200, 200))
    d.rectangle([band, band, 799 - band, 599 - band], outline=(0, 0, 0), width=3)
    d.text((350, 290), '800x600', fill=(0, 0, 0))
    img.save(PNG)


def make():
    source_png()
    app = win32.DispatchEx('Word.Application')
    app.Visible = True
    doc = app.Documents.Add()
    sel = app.Selection

    def text(s):
        sel.TypeText(s)
        sel.TypeParagraph()

    def picture(w, h, crop=None, floating=None, align=wdShapeLeft):
        shape = sel.InlineShapes.AddPicture(PNG, False, True)
        shape.Width = w
        shape.Height = h
        if crop:
            for side, value in zip(('CropLeft', 'CropRight', 'CropTop', 'CropBottom'), crop):
                setattr(shape.PictureFormat, side, value)
        if floating is not None:
            shape = shape.ConvertToShape()
            shape.WrapFormat.Type = floating
            shape.RelativeHorizontalPosition = wdRelHColumn
            shape.RelativeVerticalPosition = wdRelVParagraph
            shape.Left = align
            shape.Top = 0
        return shape

    text('V3 验收样本：裁剪与环绕')
    text('下面这张图四边都裁剪（左 16.7% 右 12.5% 上 13.3% 下 8.9%）：')
    picture(400, 300, crop=(100, 80, 60, 40))
    text('')

    for pos, label in ((wdShapeLeft, '左'), (wdShapeCenter, '中'), (wdShapeRight, '右')):
        text(f'上下型-{label}：这一段应该排在图片上方。')
        picture(160, 120, floating=wdWrapTopBottom, align=pos)
        text(f'上下型-{label}：这一段应该排在图片下方。')
        text('')

    text('四周型：正文应该在图片右侧绕排。')
    picture(150, 112, floating=wdWrapSquare, align=wdShapeLeft)
    text('四周型结束。')

    text('紧密型：导入时应该被简化，并触发提示。')
    picture(150, 112, floating=wdWrapTight, align=wdShapeRight)
    text('紧密型结束。')

    text('表格单元格里的图片：')
    table = doc.Tables.Add(sel.Range, 2, 2)
    table.Cell(1, 1).Range.Text = '左上'
    table.Cell(1, 2).Range.Text = '右上'
    table.Cell(2, 1).Range.Text = '左下'
    cell = table.Cell(2, 2)
    cell.Range.Text = ''
    shape = doc.InlineShapes.AddPicture(PNG, False, True, cell.Range)
    shape.Width = 80
    shape.Height = 60

    doc.SaveAs2(FIXTURE)
    doc.Close(False)
    app.Quit()
    print('saved', FIXTURE)


if __name__ == '__main__':
    make()
