package db

import (
	"context"
	"time"

	"github.com/lindenkurtz/TakaTime/internal/types"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func AddEntryToMongo(logs []types.LogEntry, mongoURI string) error {
	ctx, cancle := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancle()

	clientOption := options.Client().ApplyURI(mongoURI)
	client, err := mongo.Connect(clientOption)

	if err != nil {
		// log.Printf("Cannot connect to mongodb %s", err)
		return err
	}

	defer client.Disconnect(ctx)

	collection := client.Database("takatime").Collection("logs")
	var documents []any
	//add logs
	for _, log := range logs {
		documents = append(documents, log)
	}

	_, err = collection.InsertMany(ctx, documents)
	if err != nil {
		return err
	}

	return nil
}
