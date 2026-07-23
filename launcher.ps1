$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:selectedMode = $null

$form = New-Object System.Windows.Forms.Form
$form.Text = '包袋电商图片批处理'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(430, 395)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = '请选择本次要执行的独立处理步骤：'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(30, 24)
$form.Controls.Add($label)

function Add-ModeButton {
    param(
        [string]$Text,
        [string]$Mode,
        [int]$Top
    )

    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Tag = $Mode
    $button.Size = New-Object System.Drawing.Size(370, 42)
    $button.Location = New-Object System.Drawing.Point(30, $Top)
    $button.Add_Click({
        $script:selectedMode = [string]$this.Tag
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    })
    $form.Controls.Add($button)
}

Add-ModeButton -Text '1. 批量生成白底图' -Mode 'white' -Top 58
Add-ModeButton -Text '2. 批量替换印花图案' -Mode 'pattern' -Top 108
Add-ModeButton -Text '3. 批量生成主图和 5 张详情图' -Mode 'gallery' -Top 158
Add-ModeButton -Text '4. 批量复检并修复印花遗漏' -Mode 'check' -Top 208
Add-ModeButton -Text '5. 检测并移出 LV 相关图片' -Mode 'lvcheck' -Top 258
Add-ModeButton -Text '6. 自动完成替换、修复和检测' -Mode 'auto' -Top 308

$form.Add_Shown({
    $form.Activate()
    $form.BringToFront()
})

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $script:selectedMode) {
    Write-Host '已取消处理。'
    exit 0
}

$descriptions = @{
    white = '选择包含原始产品图片的文件夹'
    pattern = '选择包含待替换印花图片的文件夹'
    gallery = '选择包含印花成品图片的文件夹'
    check = '选择包含印花替换成品图片的文件夹，或日期目录'
    lvcheck = '选择需要检测并分类 LV 相关内容的图片文件夹'
    auto = '选择需要自动完成纹样替换、检测修复和 LV 检测的原始图片文件夹'
}

$folderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
$folderDialog.Description = $descriptions[$script:selectedMode]
$folderDialog.ShowNewFolderButton = $false

$folderResult = $folderDialog.ShowDialog()
if ($folderResult -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host '已取消文件夹选择。'
    exit 0
}

$runScript = Join-Path $PSScriptRoot 'run.mjs'
Write-Host "处理模式：$($script:selectedMode)"
Write-Host "图片目录：$($folderDialog.SelectedPath)"
Write-Host ''

& node $runScript --mode $script:selectedMode --input $folderDialog.SelectedPath
exit $LASTEXITCODE
