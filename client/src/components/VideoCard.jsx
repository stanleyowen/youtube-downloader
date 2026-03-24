import { Clock, Eye, User } from 'lucide-react';

export default function VideoCard({ video }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl overflow-hidden shadow-lg border border-gray-100 dark:border-gray-700">
      <div className="relative">
        <img
          src={video.thumbnail}
          alt={video.title}
          className="w-full aspect-video object-cover"
        />
        {video.duration && (
          <span className="absolute bottom-2 right-2 bg-black/80 text-white text-sm px-2 py-1 rounded">
            {video.duration}
          </span>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-semibold text-gray-900 dark:text-white line-clamp-2 mb-2">
          {video.title}
        </h3>
        <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
          {video.channel && (
            <span className="flex items-center gap-1">
              <User className="h-4 w-4" />
              {video.channel}
            </span>
          )}
          {video.viewCount && (
            <span className="flex items-center gap-1">
              <Eye className="h-4 w-4" />
              {video.viewCount} views
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
