import { useState } from 'react';
import { Link, Clipboard, Loader2 } from 'lucide-react';

export default function UrlInput({ onSubmit, loading }) {
  const [url, setUrl] = useState('');

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
    } catch (err) {
      console.error('Failed to paste:', err);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (url.trim()) {
      onSubmit(url.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Link className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste video URL here..."
            className="w-full pl-12 pr-12 py-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
            disabled={loading}
          />
          <button
            type="button"
            onClick={handlePaste}
            className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Paste from clipboard"
          >
            <Clipboard className="h-5 w-5" />
          </button>
        </div>
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="px-6 py-4 bg-red-500 hover:bg-red-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-medium rounded-xl transition-all disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Loading...</span>
            </>
          ) : (
            <span>Fetch</span>
          )}
        </button>
      </div>
    </form>
  );
}
