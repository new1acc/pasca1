import React, { useState, useEffect, useRef } from "react";
import { Upload, FileText, Lock, Unlock, CheckCircle, XCircle, Loader2, Play, Zap, Copy, Check, FileArchive, FileSpreadsheet, File } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [passwordList, setPasswordList] = useState<File | null>(null);
  const [useBuiltInCodes, setUseBuiltInCodes] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState<{ current: number; total: number; password?: string } | null>(null);
  const [result, setResult] = useState<{ success: boolean; password?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [passwordsTested, setPasswordsTested] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf': return <FileText className="w-8 h-8 text-emerald-500" />;
      case 'zip': return <FileArchive className="w-8 h-8 text-emerald-500" />;
      case 'xlsx': return <FileSpreadsheet className="w-8 h-8 text-emerald-500" />;
      case 'txt':
      case 'csv': return <FileText className="w-8 h-8 text-emerald-500" />;
      default: return <File className="w-8 h-8 text-emerald-500" />;
    }
  };
  
  const workersRef = useRef<Worker[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const workerProgressRef = useRef<number[]>([]);

  const stopWorkers = () => {
    workersRef.current.forEach(w => w.terminate());
    workersRef.current = [];
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const formatTime = (ms: number) => {
    const seconds = (ms / 1000).toFixed(7);
    const parts = seconds.split('.');
    const totalSeconds = parseInt(parts[0]);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${parts[1]}`;
  };

  const withRetry = async <T,>(fn: () => Promise<T>, retries = 3, delay = 500): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (retries <= 0) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
  };

  const handleStart = async () => {
    if (!file || (!passwordList && !useBuiltInCodes)) {
      setError("Please upload a file and provide a password source.");
      return;
    }

    setError(null);
    setResult(null);
    setProgress(null);
    setElapsedTime(0);
    setPasswordsTested(0);
    setStatus("Initializing local workers...");
    setIsTesting(true);
    startTimeRef.current = Date.now();
    
    timerRef.current = setInterval(() => {
      setElapsedTime(Date.now() - startTimeRef.current);
    }, 10);

    try {
      const fileBuffer = await withRetry<ArrayBuffer>(() => file.arrayBuffer());
      const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 8);
      workerProgressRef.current = new Array(numWorkers).fill(0);
      
      let totalPasswords = 0;
      let passwords: string[] | null = null;
      let range: { start: number; end: number; pad: number } | null = null;

      if (useBuiltInCodes) {
        totalPasswords = 1000000;
        range = { start: 0, end: 1000000, pad: 6 };
      } else if (passwordList) {
        const passwordText = await withRetry<string>(() => passwordList.text());
        passwords = passwordText.split(/\r?\n/).map(p => p.trim()).filter(p => p.length > 0);
        totalPasswords = passwords.length;
      }

      if (totalPasswords === 0) {
        throw new Error("Password list is empty.");
      }

      const chunkSize = Math.ceil(totalPasswords / numWorkers);
      let found = false;
      let workersDone = 0;

      stopWorkers();

      for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker(new URL("./workers/passwordTester.ts", import.meta.url), { type: "module" });
        workersRef.current.push(worker);

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalPasswords);
        
        worker.onmessage = (e) => {
          if (found) return;

          const data = e.data;
          if (data.type === "success") {
            found = true;
            setIsTesting(false);
            setResult({ success: true, password: data.password });
            setStatus(`Password found: ${data.password}`);
            stopWorkers();
          } else if (data.type === "progress") {
            workerProgressRef.current[data.workerId] = data.current;
            const totalTested = workerProgressRef.current.reduce((a, b) => a + b, 0);
            setPasswordsTested(totalTested);
            setProgress({ current: totalTested, total: totalPasswords, password: data.password });
          } else if (data.type === "done") {
            workersDone++;
            if (workersDone === numWorkers && !found) {
              setIsTesting(false);
              setResult({ success: false });
              setStatus("No password from the list could unlock this file.");
              stopWorkers();
            }
          }
        };

        if (useBuiltInCodes && range) {
          worker.postMessage({
            range: { start: start, end: end, pad: range.pad },
            fileBuffer,
            fileName: file.name.toLowerCase(),
            workerId: i
          });
        } else if (passwords) {
          worker.postMessage({
            passwords: passwords.slice(start, end),
            fileBuffer,
            fileName: file.name.toLowerCase(),
            workerId: i
          });
        }
      }

      setStatus(`Testing with ${numWorkers} parallel threads...`);
    } catch (err: any) {
      setError(err.message);
      setIsTesting(false);
      stopWorkers();
    }
  };

  const reset = () => {
    stopWorkers();
    setFile(null);
    setPasswordList(null);
    setIsTesting(false);
    setStatus("");
    setProgress(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-6 md:p-12">
      <div className="max-w-3xl mx-auto space-y-12">
        {/* Header */}
        <header className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
              <Zap className="w-8 h-8 text-emerald-500" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight">Offline Password Tester</h1>
          </div>
          <p className="text-zinc-400 text-lg max-w-xl">
            Fast, multithreaded testing directly in your browser. 
            Your files never leave your computer.
          </p>
        </header>

        {/* Main Content */}
        <main className="grid gap-8">
          <div className="grid md:grid-cols-2 gap-6">
            {/* File Upload */}
            <div className="space-y-4">
              <label className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Target File</label>
              <div 
                className={`relative group h-48 rounded-3xl border-2 border-dashed transition-all duration-300 flex flex-col items-center justify-center gap-4 cursor-pointer
                  ${file ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/50'}`}
              >
                <input 
                  type="file" 
                  className="absolute inset-0 opacity-0 cursor-pointer" 
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  accept=".pdf,.zip,.xlsx"
                />
                {file ? (
                  <>
                    <div className="p-3 bg-emerald-500/20 rounded-xl">
                      {getFileIcon(file.name)}
                    </div>
                    <div className="text-center px-4">
                      <p className="font-medium truncate max-w-[200px]">{file.name}</p>
                      <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-3 bg-zinc-800 rounded-xl group-hover:bg-zinc-700 transition-colors">
                      <Upload className="w-8 h-8 text-zinc-400" />
                    </div>
                    <div className="text-center">
                      <p className="font-medium">Upload File</p>
                      <p className="text-xs text-zinc-500">PDF, ZIP, or XLSX</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Password List Upload or Built-in */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Password Source</label>
                <button 
                  onClick={() => setUseBuiltInCodes(!useBuiltInCodes)}
                  className={`text-xs font-bold px-3 py-1 rounded-full border transition-all ${useBuiltInCodes ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}
                >
                  {useBuiltInCodes ? "Using 6-Digit Codes" : "Use Built-in Codes"}
                </button>
              </div>
              
              {useBuiltInCodes ? (
                <div className="h-48 rounded-3xl border-2 border-emerald-500/20 bg-emerald-500/5 flex flex-col items-center justify-center gap-4 p-6 text-center">
                  <div className="p-3 bg-emerald-500/20 rounded-xl">
                    <Zap className="w-8 h-8 text-emerald-500" />
                  </div>
                  <div>
                    <p className="font-medium text-emerald-500">6-Digit Brute Force</p>
                    <p className="text-xs text-zinc-500 mt-1">Testing 1,000,000 combinations<br/>(000000 - 999999)</p>
                  </div>
                </div>
              ) : (
                <div 
                  className={`relative group h-48 rounded-3xl border-2 border-dashed transition-all duration-300 flex flex-col items-center justify-center gap-4 cursor-pointer
                    ${passwordList ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/50'}`}
                >
                  <input 
                    type="file" 
                    className="absolute inset-0 opacity-0 cursor-pointer" 
                    onChange={(e) => setPasswordList(e.target.files?.[0] || null)}
                    accept=".txt,.csv"
                  />
                  {passwordList ? (
                    <>
                      <div className="p-3 bg-emerald-500/20 rounded-xl">
                        {getFileIcon(passwordList.name)}
                      </div>
                      <div className="text-center px-4">
                        <p className="font-medium truncate max-w-[200px]">{passwordList.name}</p>
                        <p className="text-xs text-zinc-500">{(passwordList.size / 1024).toFixed(2)} KB</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="p-3 bg-zinc-800 rounded-xl group-hover:bg-zinc-700 transition-colors">
                        <Upload className="w-8 h-8 text-zinc-400" />
                      </div>
                      <div className="text-center">
                        <p className="font-medium">Upload List</p>
                        <p className="text-xs text-zinc-500">.txt or .csv</p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action Button */}
          <div className="flex justify-center pt-4">
            {!isTesting && !result ? (
              <button
                onClick={handleStart}
                disabled={!file || (!passwordList && !useBuiltInCodes)}
                className="group relative px-8 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-bold rounded-2xl transition-all duration-300 flex items-center gap-3 shadow-lg shadow-emerald-500/20"
              >
                <Play className="w-5 h-5 fill-current" />
                Start Multithreaded Test
              </button>
            ) : (
              <button
                onClick={reset}
                className="px-8 py-4 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 font-bold rounded-2xl border border-zinc-800 transition-all duration-300"
              >
                Reset & Start Over
              </button>
            )}
          </div>

          {/* Status & Progress */}
          <AnimatePresence>
            {(isTesting || result || status) && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-12 space-y-12"
              >
                {/* Stats Grid - Matching Screenshot */}
                <div className="space-y-12">
                  <div className="flex items-center justify-between">
                    <span className="text-xl text-zinc-400">Passwords tested:</span>
                    <div className="text-right">
                      <span className="text-5xl font-medium tracking-tight">{passwordsTested.toLocaleString()}</span>
                      {progress && (
                        <div className="text-sm text-zinc-500 mt-1 font-mono">
                          of {progress.total.toLocaleString()} ({((progress.current / progress.total) * 100).toFixed(2)}%)
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col items-center justify-center py-8">
                    <span className="text-8xl font-medium text-zinc-500 tracking-tighter">
                      {progress?.password || "......"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xl text-zinc-400">Time elapsed:</span>
                    <span className="text-4xl font-mono font-medium tracking-tight">
                      {formatTime(elapsedTime)}
                    </span>
                  </div>
                </div>

                {/* Progress Bar */}
                {progress && (
                  <div className="space-y-4 pt-8 border-t border-zinc-800">
                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-emerald-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                        transition={{ duration: 0.1 }}
                      />
                    </div>
                    <div className="flex justify-between text-sm text-zinc-500">
                      <span>{status}</span>
                      <span>{((progress.current / progress.total) * 100).toFixed(2)}% Complete</span>
                    </div>
                  </div>
                )}

                {result?.success && result.password && (
                  <motion.div 
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="p-8 bg-emerald-500/10 border border-emerald-500/20 rounded-3xl flex items-center justify-between"
                  >
                    <div className="flex items-center gap-6">
                      <div className="p-4 bg-emerald-500 rounded-2xl">
                        <Unlock className="w-8 h-8 text-zinc-950" />
                      </div>
                      <div>
                        <p className="text-sm text-emerald-500 font-bold uppercase tracking-widest">Password Found</p>
                        <p className="text-4xl font-mono font-bold">{result.password}</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(result.password!);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="px-8 py-4 bg-emerald-500 text-zinc-950 font-bold rounded-2xl hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20 flex items-center gap-2"
                    >
                      {copied ? (
                        <>
                          <Check className="w-5 h-5" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-5 h-5" />
                          Copy Password
                        </>
                      )}
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-500 text-sm text-center"
            >
              {error}
            </motion.div>
          )}
        </main>

        {/* Footer Info */}
        <footer className="pt-12 border-t border-zinc-900 text-center space-y-4">
          <div className="flex justify-center gap-8 text-xs font-bold uppercase tracking-widest text-zinc-600">
            <span className="flex items-center gap-2"><Zap className="w-3 h-3" /> Hardware Accelerated</span>
            <span className="flex items-center gap-2"><Unlock className="w-3 h-3" /> 100% Client-Side</span>
            <span className="flex items-center gap-2"><FileText className="w-3 h-3" /> Privacy First</span>
          </div>
          <p className="text-xs text-zinc-700">
            Your data never leaves your browser. Testing speed depends on your CPU's core count.
          </p>
        </footer>
      </div>
    </div>
  );
}
