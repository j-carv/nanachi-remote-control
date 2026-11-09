import { join } from 'node:path';

// Emit P/Invoke signatures in-process: Add-Type would launch an unowned csc.exe during cancellable startup.
// Job membership is assigned by CreateProcess itself, never in a racy post-spawn step.
const JOB_HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$assemblyName = New-Object Reflection.AssemblyName('NanachiCommandNative')
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$type = $module.DefineType('NanachiCommandNative', [Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Define-Native([string]$name, [Type]$result, [Type[]]$parameters) {
  $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
    [Reflection.CallingConventions]::Standard, $result, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Define-Native 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
Define-Native 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Define-Native 'InitializeProcThreadAttributeList' ([bool]) @([IntPtr], [int], [int], [IntPtr])
Define-Native 'UpdateProcThreadAttribute' ([bool]) @([IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr])
Define-Native 'DeleteProcThreadAttributeList' ([void]) @([IntPtr])
Define-Native 'CreateProcessW' ([bool]) @([string], [Text.StringBuilder], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [string], [IntPtr], [IntPtr])
Define-Native 'GetStdHandle' ([IntPtr]) @([int])
Define-Native 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
Define-Native 'GetExitCodeProcess' ([bool]) @([IntPtr], [IntPtr])
Define-Native 'CloseHandle' ([bool]) @([IntPtr])
$native = $type.CreateType()
function Assert-Native([bool]$succeeded) {
  if (-not $succeeded) { throw 'Windows command process ownership could not be established.' }
}
function Quote-Argument([string]$value) {
  $result = New-Object Text.StringBuilder
  $null = $result.Append([char]34)
  $slashes = 0
  foreach ($character in $value.ToCharArray()) {
    if ($character -eq [char]92) { $slashes++; continue }
    if ($character -eq [char]34) { $null = $result.Append([char]92, $slashes * 2 + 1) }
    else { $null = $result.Append([char]92, $slashes) }
    $null = $result.Append($character)
    $slashes = 0
  }
  $null = $result.Append([char]92, $slashes * 2)
  $null = $result.Append([char]34)
  return $result.ToString()
}
$job = [IntPtr]::Zero
$attributes = [IntPtr]::Zero
$process = [IntPtr]::Zero
$thread = [IntPtr]::Zero
$allocated = New-Object 'Collections.Generic.List[IntPtr]'
$initialized = $false
function Allocate-Zero([int]$size) {
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  $allocated.Add($pointer)
  [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size), 0, $pointer, $size)
  return $pointer
}
try {
  $job = $native::CreateJobObjectW([IntPtr]::Zero, $null)
  Assert-Native ($job -ne [IntPtr]::Zero)
  $wide = [IntPtr]::Size -eq 8
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes on x64, 112 on x86; Basic.LimitFlags is DWORD at offset16.
  $limitsSize = if ($wide) { 144 } else { 112 }
  $limits = Allocate-Zero $limitsSize
  [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000) # KILL_ON_JOB_CLOSE; never allow breakaway.
  Assert-Native ($native::SetInformationJobObject($job, 9, $limits, $limitsSize))
  $attributeSize = Allocate-Zero ([IntPtr]::Size)
  $null = $native::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, $attributeSize)
  $attributes = Allocate-Zero ([Runtime.InteropServices.Marshal]::ReadIntPtr($attributeSize).ToInt32())
  Assert-Native ($native::InitializeProcThreadAttributeList($attributes, 1, 0, $attributeSize))
  $initialized = $true
  $jobs = Allocate-Zero ([IntPtr]::Size)
  [Runtime.InteropServices.Marshal]::WriteIntPtr($jobs, $job)
  # PROC_THREAD_ATTRIBUTE_JOB_LIST: atomic membership before any child instruction, including all descendants.
  Assert-Native ($native::UpdateProcThreadAttribute($attributes, 0, [IntPtr]0x2000D, $jobs, [IntPtr]([IntPtr]::Size), [IntPtr]::Zero, [IntPtr]::Zero))
  # STARTUPINFOEX contains STARTUPINFO followed by the attribute-list pointer (104/68 bytes on x64/x86).
  $startupSize = if ($wide) { 112 } else { 72 }
  $flagsOffset = if ($wide) { 60 } else { 44 }
  $inputOffset = if ($wide) { 80 } else { 56 }
  $attributesOffset = if ($wide) { 104 } else { 68 }
  $startup = Allocate-Zero $startupSize
  [Runtime.InteropServices.Marshal]::WriteInt32($startup, 0, $startupSize)
  [Runtime.InteropServices.Marshal]::WriteInt32($startup, $flagsOffset, 0x101) # USESTDHANDLES | USESHOWWINDOW(hidden).
  [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, $inputOffset, $native::GetStdHandle(-10))
  [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, $inputOffset + [IntPtr]::Size, $native::GetStdHandle(-11))
  [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, $inputOffset + [IntPtr]::Size * 2, $native::GetStdHandle(-12))
  [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, $attributesOffset, $attributes)
  $processInfo = Allocate-Zero ([IntPtr]::Size * 2 + 8)
  $command = New-Object Text.StringBuilder
  $null = $command.Append((Quote-Argument $launch.file))
  foreach ($argument in $launch.args) {
    $null = $command.Append(' ')
    if ($launch.verbatim) { $null = $command.Append($argument) }
    else { $null = $command.Append((Quote-Argument $argument)) }
  }
  Assert-Native ($native::CreateProcessW($launch.file, $command, [IntPtr]::Zero, [IntPtr]::Zero, $true, 0x80000, [IntPtr]::Zero, $launch.cwd, $startup, $processInfo))
  $process = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo)
  $thread = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, [IntPtr]::Size)
  Assert-Native ($native::WaitForSingleObject($process, [uint32]::MaxValue) -eq 0)
  $exitCode = Allocate-Zero 4
  Assert-Native ($native::GetExitCodeProcess($process, $exitCode))
  $code = [Runtime.InteropServices.Marshal]::ReadInt32($exitCode)
} finally {
  if ($thread -ne [IntPtr]::Zero) { $null = $native::CloseHandle($thread) }
  if ($process -ne [IntPtr]::Zero) { $null = $native::CloseHandle($process) }
  if ($job -ne [IntPtr]::Zero) { $null = $native::CloseHandle($job) }
  if ($initialized) { $native::DeleteProcThreadAttributeList($attributes) }
  foreach ($pointer in $allocated) { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
}
[Environment]::Exit($code)
`;

/** Local Windows 10+ host; policy restrictions fail visibly, with no compiler, PTY, or execution-policy bypass. */
export function windowsJobCommand(file: string, args: string[], cwd: string, verbatim: boolean): { file: string; args: string[]; input: string } {
  const payload = Buffer.from(JSON.stringify({ file, args, cwd, verbatim }), 'utf8').toString('base64');
  return {
    file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'],
    // ReadToEnd consumes all bootstrap input before CreateProcess; the actual command inherits EOF stdin.
    input: `$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${JOB_HOST}`,
  };
}
