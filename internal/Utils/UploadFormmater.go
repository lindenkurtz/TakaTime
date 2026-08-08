package utils

import (
	"strings"

	"github.com/lindenkurtz/TakaTime/internal/types"
)

func FormmatUpload(token string, repoURL string, path string, branch string, commitMsg string) (types.UploadStruct, error) {

	if len(commitMsg) == 0 {
		commitMsg = "Adding toadys stats"
	}


	splitRepoName := strings.Split(repoURL, "/")

	uploadStruct := types.UploadStruct{
		Token:     token,
		Owner:     splitRepoName[0],
		Repo:      splitRepoName[1],
		Path:      path,
		Branch:    branch,
		CommitMsg: commitMsg,
	}

	return uploadStruct, nil

}
